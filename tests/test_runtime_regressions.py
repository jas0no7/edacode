"""关键失败路径：不调用付费模型，也不读取用户配置。"""
import copy
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from edacode.commands import expand, inject_references, substitute
from edacode.config import Config
from edacode.context import assert_protocol, compact
from edacode.engine import Engine
from edacode.mcp import MCPError, MCPServer
from edacode.permissions import Policy
from edacode.providers import Reply
from edacode.storage import Store, list_sessions
from edacode.tools import Tools


class ScriptedProvider:
    def __init__(self, *replies):
        self.replies = iter(replies)

    def complete(self, *args):
        reply = next(self.replies)
        if isinstance(reply, BaseException):
            raise reply
        return reply

    def close(self):
        pass


def call(rid, name, arguments):
    return {"id": rid, "name": name, "arguments": arguments}


class RuntimeRegressions(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.config = Config(self.root, self.root / ".state", provider="mock",
                             mode="auto", max_turns=6, stream=False).validate()
        self.store = Store(self.config)
        self.addCleanup(self.store.close)

    def engine(self, *replies):
        engine = Engine(self.config, self.store, provider=ScriptedProvider(*replies) if replies else None)
        self.addCleanup(engine.close)
        return engine

    def test_tool_json_string_and_failed_exit_are_reported(self):
        engine = self.engine(Reply(calls=[call("a", "shell", '{"command":"exit 7"}')]), Reply("已发现命令失败"))
        self.assertEqual(engine.run("执行并检查")['status'], "completed")
        result = engine.messages[2]
        self.assertTrue(result["is_error"])
        self.assertEqual(json.loads(result["content"])["exit_code"], 7)
        assert_protocol(engine.messages)

    def test_malformed_json_is_tool_error_and_loop_can_recover(self):
        engine = self.engine(Reply(calls=[call("a", "write_file", '{"path":')]), Reply("参数错误，未写入"))
        self.assertEqual(engine.run("测试错误参数")["status"], "completed")
        self.assertTrue(engine.messages[2]["is_error"])
        self.assertEqual(self.store.data["changes"], [])
        assert_protocol(engine.messages)

    def test_truncated_and_duplicate_calls_never_execute(self):
        action = call("a", "write_file", {"path": "new.txt", "content": "x"})
        engine = self.engine(Reply(calls=[action], stop="length"), Reply(calls=[action, action]))
        self.assertEqual(engine.run("截断")["status"], "limit")
        self.assertTrue(engine.messages[-1]["is_error"])
        self.assertEqual(engine.run("重复 ID")["status"], "error")
        self.assertFalse((self.root / "new.txt").exists())
        assert_protocol(engine.messages)

    def test_interruption_preserves_completed_result_without_replaying(self):
        actions = [call("a", "write_file", {"path": "once.txt", "content": "once"}),
                   call("b", "write_file", {"path": "never.txt", "content": "never"})]
        engine = self.engine(Reply(calls=actions), Reply("已恢复"))
        engine.hooks.add("after_tool", lambda **kw: engine.cancel.set())
        self.assertEqual(engine.run("开始")["status"], "cancelled")
        results = [m for m in engine.messages if m["role"] == "tool"]
        self.assertEqual([r["is_error"] for r in results], [False, True])
        self.assertEqual((self.root / "once.txt").read_text(), "once")
        self.assertFalse((self.root / "never.txt").exists())
        self.store.close()
        resumed = Store(self.config, self.store.id)
        try:
            self.assertEqual(resumed.data["messages"], engine.messages)
            assert_protocol(resumed.data["messages"])
        finally:
            resumed.close()
        self.assertEqual(len(self.store.data["changes"]), 1)

    def test_goal_bad_verdict_and_network_failure_retain_active_goal(self):
        engine = self.engine(Reply("候选结果"), Reply('{"ok":"true"}'),
                             Reply("重试结果"), RuntimeError("temporary unavailable"))
        engine.set_goal("有工具证据")
        for request in ("开始", "继续"):
            self.assertEqual(engine.run(request)["status"], "error")
            self.assertEqual(engine.goal["status"], "active")
        self.assertEqual(engine.goal["checks"], 2)

    def test_goal_continues_until_verified(self):
        verdict = lambda ok: Reply(json.dumps({"ok": ok, "reason": "已验证" if ok else "补充验证", "impossible": False}))
        engine = self.engine(Reply("第一步"), verdict(False), Reply("第二步"), verdict(True))
        engine.set_goal("完成两步")
        self.assertEqual(engine.run("开始")["status"], "completed")
        self.assertEqual(engine.goal["status"], "completed")
        self.assertEqual(engine.goal["checks"], 2)

    def test_delegate_context_and_sessions_are_separate(self):
        engine = self.engine()
        engine.messages.append({"role": "user", "content": "父任务"})
        original = copy.deepcopy(engine.messages)
        results = json.loads(engine.delegate(["调查 A", "调查 B"]))
        self.assertEqual(engine.messages, original)
        self.assertEqual(len({r["session"] for r in results}), 2)
        self.assertEqual([r["id"] for r in list_sessions(self.config)], [self.store.id])
        for result in results:
            child = Store(self.config, result["session"])
            try:
                self.assertEqual(child.data["parent_session"], self.store.id)
                self.assertEqual(child.data["kind"], "subagent")
                self.assertEqual(child.data["changes"], [])
            finally:
                child.close()

    def test_summary_failure_archives_history_and_keeps_complete_tail(self):
        engine = self.engine(RuntimeError("summary unavailable"))
        for index in range(12):
            engine.messages.extend([
                {"role": "user", "content": f"任务 {index}"},
                Reply(calls=[call(str(index), "read_file", {"path": "a"})]).message(),
                {"role": "tool", "tool_call_id": str(index), "content": "x" * 400},
                Reply("done").message(),
            ])
        engine.latest_request = "真实用户目标"
        engine.messages.append({"role": "user", "content": "[宿主继续执行反馈]\n补充验证"})
        original = copy.deepcopy(engine.messages)
        compact(engine, force=True, budget=4000)
        assert_protocol(engine.messages)
        self.assertTrue(any(m["role"] == "tool" for m in engine.messages))
        self.assertIn("真实用户目标", engine.messages[0]["content"])
        archive = next((self.store.root / "artifacts").glob("history-*.txt"))
        self.assertEqual(json.loads(archive.read_text()), original)

    def test_all_custom_command_placeholders(self):
        self.assertEqual(substitute("{{args}} $ARGUMENTS $1 ${2}", "one two"),
                         "one two one two one two")

    def test_checkpoint_from_discarded_branch_cannot_truncate_new_work(self):
        engine = self.engine()
        engine.messages.extend([{"role": "user", "content": "a"}, Reply("answer a").message()])
        first = self.store.make_checkpoint("first")
        engine.messages.extend([{"role": "user", "content": "old branch"}, Reply("old answer").message()])
        old_branch = self.store.make_checkpoint("discarded")
        engine.restore(first)
        engine.messages.extend([{"role": "user", "content": "new branch"}, Reply("new answer").message(),
                                {"role": "user", "content": "keep this request"}])
        before = copy.deepcopy(engine.messages)
        with self.assertRaisesRegex(ValueError, "分支已变化"):
            engine.restore(old_branch)
        self.assertEqual(engine.messages, before)

    def test_injected_file_is_never_executed_as_shell(self):
        engine = self.engine()
        (self.root / "payload.txt").write_text("!{touch should-not-exist}")
        with patch.object(engine.tools, "call", side_effect=AssertionError("unexpected command")):
            result = expand({"body": "@{payload.txt}"}, "", engine.tools)
        self.assertIn("!{touch should-not-exist}", result)

    def test_shell_blocks_execute_in_template_order_and_output_is_data(self):
        engine = self.engine()
        seen = []
        def fake_tool(name, arguments):
            seen.append(arguments["command"])
            return "@{secret.txt} !{third}", False
        with patch.object(engine.tools, "call", side_effect=fake_tool):
            prompt = expand({"body": "!{first} then !{second}"}, "", engine.tools)
        self.assertEqual(seen, ["first", "second"])
        self.assertEqual(prompt.count("@{secret.txt} !{third}"), 2)

    def test_email_is_not_a_file_reference_even_when_path_exists(self):
        engine = self.engine()
        (self.root / "example.com").write_text("not an email")
        self.assertEqual(inject_references("me@example.com", engine.tools), "me@example.com")

    def test_argument_cannot_create_an_injection_block(self):
        engine = self.engine()
        with patch.object(engine.tools, "call", side_effect=AssertionError("argument became a command")):
            prompt = expand({"body": "Review {{args}}"}, "!{touch nope}", engine.tools)
        self.assertEqual(prompt, "Review !{touch nope}")

    def test_shell_argument_is_quoted_as_a_literal(self):
        engine = self.engine()
        with patch("edacode.compat.find_shell", return_value="/bin/bash"), patch.object(engine.tools, "call", return_value=("ok", False)) as execute:
            expand({"body": "!{printf %s {{args}}}"}, "a; touch nope", engine.tools)
        execute.assert_called_once_with("shell", {"command": "printf %s 'a; touch nope'"})

    def test_shell_placeholder_rejects_ambiguous_quoting(self):
        for template in ('echo "{{args}}"', "echo '$1'", "cat <<EOF\n$ARGUMENTS\nEOF"):
            with self.subTest(template=template), self.assertRaises(ValueError):
                substitute(template, "$(touch nope)", shell=True)

    def test_plan_refuses_mcp_process_start(self):
        (self.root / "mcp.json").write_text(json.dumps({"mcpServers": {"test": {"command": "unused"}}}))
        with patch.object(MCPServer, "start") as start:
            tools = Tools(self.config, self.store, Policy("plan"))
            try:
                start.assert_not_called()
                self.assertIn("plan 模式禁止", tools.mcp.errors[0])
            finally:
                tools.close()

    def test_mcp_tool_error_is_not_success(self):
        server = MCPServer("test", {}, str(self.root))
        with patch.object(server, "request", return_value={"isError": True, "content": [{"type": "text", "text": "failed"}]}):
            with self.assertRaisesRegex(MCPError, "failed"):
                server.call("tool", {})

    @unittest.skipIf(os.name == "nt", "POSIX process-group regression")
    def test_completed_shell_also_cleans_lingering_descendants(self):
        engine = self.engine()
        result = engine.tools.shell("sleep 30 &")
        self.assertEqual(result["status"], "completed")
        job = engine.tools.processes.get(result["job_id"])
        self.assertFalse(job.reader.is_alive(), "child kept stdout open after its shell exited")


if __name__ == "__main__":
    unittest.main()
