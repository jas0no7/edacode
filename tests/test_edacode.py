import argparse
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

from edacode import __version__, ui
from edacode.commands import discover as discover_commands, expand, inject_references
from edacode.config import load_config
from edacode.compat import find_shell
from edacode.context import assert_protocol, compact
from edacode.engine import Engine
from edacode.permissions import Policy
from edacode.processes import Processes
from edacode.providers import Reply, anthropic_messages, openai_messages
from edacode.storage import Store
from edacode.tools import Tools


def config_for(root, mode="auto"):
    return load_config(argparse.Namespace(
        workspace=str(root), env_file=None, home=str(root / ".state"),
        provider="mock", model=None, mode=mode, max_turns=4, no_stream=True,
    ))


class EdaCodeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.config = config_for(self.root)
        self.store = Store(self.config)
        self.tools = Tools(self.config, self.store, Policy("auto"), readonly=False)

    def tearDown(self):
        self.tools.close()
        self.store.close()
        self.temp.cleanup()

    def test_workspace_boundary_and_symlink(self):
        outside = self.root.parent / "outside-edacode.txt"
        outside.write_text("secret", encoding="utf-8")
        with self.assertRaises(PermissionError):
            self.tools.read_file("../outside-edacode.txt")
        link = self.root / "link"
        try:
            link.symlink_to(outside)
        except OSError:
            self.skipTest("平台不允许创建 symlink")
        with self.assertRaises(PermissionError):
            self.tools.read_file("link")

    def test_state_directory_inside_workspace_is_protected(self):
        state_file = self.root / ".state" / "secret.txt"
        state_file.parent.mkdir(exist_ok=True)
        state_file.write_text("secret", encoding="utf-8")
        with self.assertRaises(PermissionError):
            self.tools.read_file(".state/secret.txt")
        self.assertNotIn(".state/secret.txt", self.tools.list_files())

    def test_read_before_edit_and_undo(self):
        self.assertIn("已修改", self.tools.write_file("a.txt", "one\n"))
        with self.assertRaises(ValueError):
            self.tools.edit_file("a.txt", "one", "two")
        self.tools.read_file("a.txt")
        self.tools.edit_file("a.txt", "one", "two")
        self.assertEqual((self.root / "a.txt").read_text(), "two\n")
        self.tools.undo()
        self.assertEqual((self.root / "a.txt").read_text(), "one\n")

    def test_unique_edit_and_conflict(self):
        self.tools.write_file("a.txt", "x x\n")
        self.tools.read_file("a.txt")
        with self.assertRaises(ValueError):
            self.tools.edit_file("a.txt", "x", "y")
        self.tools.write_file("b.txt", "safe\n")
        self.tools.read_file("b.txt")
        (self.root / "b.txt").write_text("changed\n", encoding="utf-8")
        with self.assertRaises(ValueError):
            self.tools.edit_file("b.txt", "changed", "new")

    def test_mock_session_and_resume(self):
        self.tools.close()
        engine = Engine(self.config, self.store)
        result = engine.run("列出当前文件")
        self.assertEqual(result["status"], "completed")
        self.assertTrue(any(m["role"] == "tool" for m in self.store.data["messages"]))
        engine.close()
        self.store.close()
        resumed = Store(self.config, self.store.id)
        self.assertGreaterEqual(len(resumed.data["messages"]), 3)
        resumed.close()

    def test_context_compaction_keeps_tool_pairs(self):
        self.store.data["messages"] = [
            {"role": "user", "content": "inspect"},
            {"role": "assistant", "content": "", "tool_calls": [{"id": "c1", "name": "read_file", "arguments": {"path": "a"}}]},
            {"role": "tool", "tool_call_id": "c1", "content": "a"},
            {"role": "assistant", "content": "done", "tool_calls": []},
        ]
        engine = Engine(self.config, self.store)
        engine.messages = self.store.data["messages"]
        compact(engine, force=True, budget=200)
        assert_protocol(engine.messages)
        self.assertFalse(any(m["role"] == "tool" and not any(a.get("id") == m["tool_call_id"] for a in engine.messages if a["role"] == "assistant") for m in engine.messages))
        engine.close()

    def test_goal_failure_is_retained(self):
        self.tools.close()
        engine = Engine(self.config, self.store)
        engine.set_goal("a condition that mock cannot verify")
        result = engine.run("check it")
        self.assertEqual(result["status"], "goal_failed")
        self.assertEqual(engine.goal["status"], "failed")
        self.assertIsNotNone(self.store.data["goal"])
        engine.close()

    def test_hard_block_does_not_run_dangerous_shell(self):
        self.tools.close()
        engine = Engine(self.config, self.store)
        output, error = engine.execute({"name": "shell", "arguments": {"command": "  sudo\tshutdown now"}})
        self.assertTrue(error)
        self.assertIn("硬拒绝", output)
        engine.close()

    def test_process_timeout_is_terminal_and_cleans_group(self):
        processes = Processes(self.root)
        try:
            result = processes.run("sleep 5", timeout=0.1)
            self.assertEqual(result["status"], "timeout")
            self.assertIsNotNone(result["exit_code"])
        finally:
            processes.close()

    def test_shell_tool_runs_command(self):
        result = self.tools.shell("echo hello-edacode")
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["exit_code"], 0)
        self.assertIn("hello-edacode", result["output"])

    def test_session_lock_is_exclusive(self):
        self.tools.close()
        with self.assertRaises(ValueError):
            Store(self.config, self.store.id)

    def test_compat_shell_is_available(self):
        self.assertTrue(find_shell())

    def test_mcp_stdio_server_is_discovered_and_called(self):
        self.tools.close()
        (self.root / "mcp.json").write_text(json.dumps({"mcpServers": {"echo": {
            "command": sys.executable, "args": [str(Path(__file__).with_name("mcp_echo_server.py"))]}}}),
            encoding="utf-8")
        tools = Tools(self.config, self.store, Policy("auto"), readonly=False)
        try:
            self.assertIn("mcp__echo__echo", tools.definitions)
            self.assertEqual(tools.mcp.errors, [])
            output, error = tools.call("mcp__echo__echo", {"text": "你好"})
            self.assertFalse(error)
            self.assertIn("echo:你好", output)
        finally:
            tools.close()

    def test_mcp_failure_is_non_fatal(self):
        self.tools.close()
        (self.root / "mcp.json").write_text(json.dumps({"mcpServers": {"broken": {
            "command": "definitely-not-a-real-binary-edacode"}}}), encoding="utf-8")
        tools = Tools(self.config, self.store, Policy("auto"), readonly=False)
        try:
            self.assertEqual(tools.mcp.servers, {})
            self.assertTrue(tools.mcp.errors)
            self.assertIn("read_file", tools.definitions)
        finally:
            tools.close()

    def test_custom_command_discovery_namespacing_and_override(self):
        project = self.root / ".edacode" / "commands"
        user = Path(self.config.home) / "commands"
        (project / "git").mkdir(parents=True)
        (user / "git").mkdir(parents=True)
        (project / "git" / "commit.md").write_text(
            "---\ndescription: 生成提交信息\n---\n项目版", encoding="utf-8")
        (user / "git" / "commit.md").write_text("用户版", encoding="utf-8")
        (user / "plain.md").write_text("用户命令", encoding="utf-8")
        commands = discover_commands(self.root, Path(self.config.home))
        self.assertIn("git:commit", commands)
        self.assertIn("plain", commands)
        self.assertEqual(commands["git:commit"]["source"], "project")
        self.assertEqual(commands["git:commit"]["description"], "生成提交信息")
        self.assertIn("项目版", commands["git:commit"]["body"])

    def test_custom_command_argument_and_file_injection(self):
        (self.root / "note.txt").write_text("NOTE-CONTENT", encoding="utf-8")
        command = {"name": "x", "source": "project", "path": self.root / "x.md",
                   "body": "审查 $1，范围 $ARGUMENTS\n@{note.txt}", "description": "d", "argument_hint": ""}
        prompt = expand(command, "alpha beta", self.tools)
        self.assertIn("审查 alpha，范围 alpha beta", prompt)
        self.assertIn("NOTE-CONTENT", prompt)
        self.assertNotIn("@{note.txt}", prompt)

    def test_custom_command_appends_arguments_without_placeholder(self):
        command = {"name": "x", "source": "project", "path": self.root / "x.md",
                   "body": "固定说明", "description": "d", "argument_hint": ""}
        self.assertTrue(expand(command, "附加内容", self.tools).endswith("附加内容"))
        self.assertEqual(expand(command, "", self.tools), "固定说明")

    def test_shell_injection_runs_in_auto_but_refused_in_plan(self):
        command = {"name": "s", "source": "project", "path": self.root / "s.md",
                   "body": "结果：!{echo injected-ok}", "description": "d", "argument_hint": ""}
        self.assertIn("injected-ok", expand(command, "", self.tools))
        plan_tools = Tools(self.config, self.store, Policy("plan"), readonly=False)
        try:
            self.assertIn("plan 模式禁止", expand(command, "", plan_tools))
        finally:
            plan_tools.close()

    def test_at_reference_injection_only_for_existing_paths(self):
        (self.root / "a.txt").write_text("HELLO-REF", encoding="utf-8")
        text = inject_references("看看 @a.txt 以及 @missing.txt", self.tools)
        self.assertIn("HELLO-REF", text)
        self.assertIn("@missing.txt", text)

    def test_directory_patterns_and_dir_reference(self):
        (self.root / "pkg").mkdir()
        (self.root / "pkg" / "mod.py").write_text("x = 1\n", encoding="utf-8")
        (self.root / "top.py").write_text("y = 2\n", encoding="utf-8")
        listing = self.tools.list_files("pkg/**/*")
        self.assertIn("pkg/mod.py", listing)
        self.assertNotIn("top.py", listing)
        self.assertIn("pkg/mod.py", inject_references("看看 @pkg", self.tools))

    def test_checkpoint_rolls_back_files_conversation_and_plan(self):
        self.tools.close()
        (self.root / "a.txt").write_text("v0\n", encoding="utf-8")
        engine = Engine(self.config, self.store)
        try:
            engine.messages.extend([{"role": "user", "content": "第一问"},
                                    {"role": "assistant", "content": "第一答", "tool_calls": []}])
            self.store.data["todos"] = [{"step": "旧计划", "status": "pending"}]
            self.store.save()
            # 模拟一次回合：回合起点快照 -> 改文件 -> 落盘检查点
            self.store.begin_checkpoint()
            engine.tools.read_file("a.txt")
            engine.tools.write_file("a.txt", "v1\n")
            engine.tools.write_file("new.txt", "新建\n")
            self.assertEqual(len(self.store.data["checkpoints"]), 1)
            checkpoint_id = self.store.data["checkpoints"][0]["id"]
            # 同一回合内的后续写入不再新建检查点
            engine.tools.read_file("a.txt")
            engine.tools.write_file("a.txt", "v2\n")
            self.assertEqual(len(self.store.data["checkpoints"]), 1)
            engine.messages.append({"role": "user", "content": "第二问"})
            self.store.save()
            result = engine.restore(checkpoint_id)
            self.assertEqual((self.root / "a.txt").read_text(), "v0\n")
            self.assertFalse((self.root / "new.txt").exists())  # 检查点后新建的文件被移除
            self.assertEqual([m["content"] for m in engine.messages], ["第一问", "第一答"])
            self.assertEqual(self.store.data["todos"], [{"step": "旧计划", "status": "pending"}])
            self.assertIn("a.txt", result["reverted"])
            self.assertIn("回滚到 2 条消息", result["conversation"])
        finally:
            engine.close()

    def test_checkpoint_skips_externally_modified_file(self):
        self.tools.close()
        (self.root / "a.txt").write_text("v0\n", encoding="utf-8")
        engine = Engine(self.config, self.store)
        try:
            self.store.begin_checkpoint()
            engine.tools.read_file("a.txt")
            engine.tools.write_file("a.txt", "v1\n")
            checkpoint_id = self.store.data["checkpoints"][0]["id"]
            (self.root / "a.txt").write_text("外部改动\n", encoding="utf-8")
            result = engine.restore(checkpoint_id)
            self.assertEqual((self.root / "a.txt").read_text(), "外部改动\n")
            self.assertEqual(result["reverted"], [])
            self.assertIn("a.txt", [path for path, _ in result["skipped"]])
        finally:
            engine.close()

    def test_checkpoint_refuses_conversation_rollback_after_compaction(self):
        self.tools.close()
        (self.root / "a.txt").write_text("v0\n", encoding="utf-8")
        engine = Engine(self.config, self.store)
        try:
            engine.messages.extend([{"role": "user", "content": "问"},
                                    {"role": "assistant", "content": "答", "tool_calls": []}])
            self.store.save()
            self.store.begin_checkpoint()
            engine.tools.read_file("a.txt")
            engine.tools.write_file("a.txt", "v1\n")
            checkpoint_id = self.store.data["checkpoints"][0]["id"]
            self.store.data["generation"] += 1  # 模拟发生过上下文压缩
            result = engine.restore(checkpoint_id)
            self.assertEqual((self.root / "a.txt").read_text(), "v0\n")
            self.assertEqual(len(engine.messages), 2)  # 对话未被截断
            self.assertIn("压缩", result["conversation"])
        finally:
            engine.close()

    def test_manual_checkpoint_without_file_change(self):
        self.tools.close()
        engine = Engine(self.config, self.store)
        try:
            checkpoint_id = engine.store.make_checkpoint("手动标记")
            self.assertTrue(checkpoint_id)
            index = self.store.data["checkpoints"]
            self.assertEqual(index[0]["kind"], "manual")
            self.assertEqual(index[0]["label"], "手动标记")
        finally:
            engine.close()


class ProviderTranslationTests(unittest.TestCase):
    """真模型路径上唯一能离线验证的部分：内部消息 -> 各家 API 报文。"""

    def test_anthropic_tool_use_and_result_pairing(self):
        messages = [
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "", "tool_calls": [
                {"id": "t1", "name": "read_file", "arguments": {"path": "a"}}]},
            {"role": "tool", "tool_call_id": "t1", "content": "data", "is_error": False},
            {"role": "assistant", "content": "done", "tool_calls": []},
        ]
        converted = anthropic_messages(messages)
        self.assertEqual([m["role"] for m in converted], ["user", "assistant", "user", "assistant"])
        block = converted[1]["content"][0]
        self.assertEqual(block, {"type": "tool_use", "id": "t1", "name": "read_file", "input": {"path": "a"}})
        result = converted[2]["content"][0]
        self.assertEqual(result, {"type": "tool_result", "tool_use_id": "t1", "content": "data", "is_error": False})

    def test_anthropic_merges_consecutive_same_role(self):
        converted = anthropic_messages([{"role": "user", "content": "a"}, {"role": "user", "content": "b"}])
        self.assertEqual(len(converted), 1)
        self.assertEqual(len(converted[0]["content"]), 2)

    def test_anthropic_empty_content_gets_placeholder(self):
        converted = anthropic_messages([{"role": "assistant", "content": "", "tool_calls": []}])
        self.assertEqual(converted[0]["content"], [{"type": "text", "text": "(空响应)"}])

    def test_anthropic_invalid_tool_arguments_are_wrapped(self):
        messages = [{"role": "assistant", "content": "",
                     "tool_calls": [{"id": "x", "name": "f", "arguments": "{not json"}]}]
        self.assertEqual(anthropic_messages(messages)[0]["content"][0]["input"], {"_invalid_json": "{not json"})

    def test_openai_message_shape(self):
        messages = [
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "", "tool_calls": [
                {"id": "t1", "name": "read_file", "arguments": {"path": "a"}}]},
            {"role": "tool", "tool_call_id": "t1", "content": "data"},
        ]
        converted = openai_messages("SYS", messages)
        self.assertEqual(converted[0], {"role": "system", "content": "SYS"})
        call = converted[2]["tool_calls"][0]
        self.assertEqual(call["type"], "function")
        self.assertEqual(call["function"]["name"], "read_file")
        self.assertEqual(json.loads(call["function"]["arguments"]), {"path": "a"})
        self.assertEqual(converted[3]["role"], "tool")
        self.assertEqual(converted[3]["tool_call_id"], "t1")

    def test_reply_message_roundtrip(self):
        calls = [{"id": "1", "name": "f", "arguments": {}}]
        self.assertEqual(Reply("t", calls, 3, 4, "end_turn").message(),
                         {"role": "assistant", "content": "t", "tool_calls": calls})


class ConfigEnvFallbackTests(unittest.TestCase):
    """全局命令的关键前提：工作区没有 .env 时，回退到用户级 <home>/.env。"""

    KEYS = ("ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "MODEL_ID", "EDACODE_MODEL")

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.workspace = self.root / "ws"
        self.home = self.root / "home"
        self.workspace.mkdir()
        self.home.mkdir()
        self._saved = {key: os.environ.pop(key, None) for key in self.KEYS}

    def tearDown(self):
        for key, value in self._saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.temp.cleanup()

    def _args(self, **overrides):
        base = dict(workspace=str(self.workspace), env_file=None, home=str(self.home),
                    provider="anthropic", model=None, mode="edit", max_turns=None, no_stream=True)
        base.update(overrides)
        return argparse.Namespace(**base)

    def test_home_env_used_when_workspace_has_none(self):
        (self.home / ".env").write_text("ANTHROPIC_API_KEY=global-key\nMODEL_ID=global-model\n", encoding="utf-8")
        config = load_config(self._args())
        self.assertEqual(config.api_key, "global-key")
        self.assertEqual(config.model, "global-model")

    def test_workspace_env_overrides_home_env(self):
        (self.home / ".env").write_text("ANTHROPIC_API_KEY=global-key\nMODEL_ID=global-model\n", encoding="utf-8")
        (self.workspace / ".env").write_text("ANTHROPIC_API_KEY=local-key\nMODEL_ID=local-model\n", encoding="utf-8")
        config = load_config(self._args())
        self.assertEqual(config.api_key, "local-key")
        self.assertEqual(config.model, "local-model")

    def test_explicit_env_file_is_exclusive_and_missing_raises(self):
        (self.home / ".env").write_text("ANTHROPIC_API_KEY=global-key\nMODEL_ID=global-model\n", encoding="utf-8")
        explicit = self.root / "custom.env"
        explicit.write_text("ANTHROPIC_API_KEY=explicit-key\nMODEL_ID=explicit-model\n", encoding="utf-8")
        config = load_config(self._args(env_file=str(explicit)))
        self.assertEqual(config.api_key, "explicit-key")
        self.assertEqual(config.model, "explicit-model")
        with self.assertRaises(ValueError):
            load_config(self._args(env_file=str(self.root / "missing.env")))

    def test_missing_everything_names_both_locations(self):
        with self.assertRaises(ValueError) as caught:
            load_config(self._args())
        # 用 resolve() 后的路径比较，避免 Windows 短路径/大小写差异导致误判。
        self.assertIn(str(self.home.resolve()), str(caught.exception))
        self.assertIn(str(self.workspace.resolve()), str(caught.exception))


class UiTests(unittest.TestCase):
    """欢迎屏与状态栏是纯函数，可以直接断言文本、宽度与降级行为。"""

    class _Tools:
        class _Mcp:
            servers = {"a": 1, "b": 2}

        mcp = _Mcp()

    def _config(self, **overrides):
        base = dict(workspace="D:/proj/demo", mode="edit",
                    model="claude-opus-4-6", provider="anthropic")
        base.update(overrides)
        return argparse.Namespace(**base)

    def test_logo_is_five_equal_width_lines(self):
        art = ui.logo("edacode")
        self.assertEqual(len(art), 5)
        self.assertEqual(len({len(row) for row in art}), 1)
        self.assertIn("█", art[0])

    def test_plain_palette_emits_no_escape_codes(self):
        plain = ui.Palette(False)
        self.assertEqual((plain.reset, plain.bold, plain.accent, plain.muted, plain.faint), ("", "", "", "", ""))
        self.assertEqual(plain.mode("auto"), "")
        self.assertEqual(plain.gradient(0, 5), "")
        self.assertNotIn("\x1b", ui.welcome(self._config(), self._Tools(), plain, width=90))

    def test_visible_width_ignores_ansi_and_counts_cjk(self):
        self.assertEqual(ui.visible_width("\x1b[31mabc\x1b[0m"), 3)
        self.assertEqual(ui.visible_width("中文"), 4)
        self.assertEqual(ui.strip("\x1b[1;2mhi\x1b[0m"), "hi")

    def test_welcome_shows_workspace_mode_model_and_version(self):
        text = ui.welcome(self._config(), self._Tools(), ui.Palette(False), width=90)
        self.assertIn("D:/proj/demo", text)
        self.assertIn("Edit", text)
        self.assertIn("claude-opus-4-6", text)
        self.assertIn(__version__, text)
        self.assertIn("2 MCP", text)

    def test_status_bar_fills_given_width(self):
        bar = ui.status_bar(self._config(), self._Tools(), ui.Palette(False), width=80)
        self.assertEqual(ui.visible_width(bar), 80)

    def test_colored_and_plain_welcome_align_identically(self):
        colored = ui.welcome(self._config(), self._Tools(), ui.Palette(True), width=90)
        plain = ui.welcome(self._config(), self._Tools(), ui.Palette(False), width=90)
        self.assertEqual(ui.strip(colored), plain)

    def test_shorten_home_only_rewrites_home_prefix(self):
        home = os.path.expanduser("~")
        self.assertEqual(ui.shorten_home(home + os.sep + "x"), "~" + os.sep + "x")
        self.assertEqual(ui.shorten_home("D:/other"), "D:/other")


if __name__ == "__main__":
    unittest.main()
