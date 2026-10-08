import argparse
import json
from pathlib import Path
import sys
import tempfile
import unittest

from edacode.commands import discover as discover_commands, expand, inject_references
from edacode.config import load_config
from edacode.compat import find_shell
from edacode.context import assert_protocol, compact
from edacode.engine import Engine
from edacode.permissions import Policy
from edacode.processes import Processes
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


if __name__ == "__main__":
    unittest.main()
