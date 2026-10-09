"""真实 SDK + 本地 HTTP/SSE 模拟服务；不访问模型服务，不需要真实密钥。"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import shlex
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

from edacode.config import Config
from edacode.context import assert_protocol
from edacode.engine import Engine
from edacode.storage import Store


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False).encode()


class Simulator(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, provider):
        super().__init__(("127.0.0.1", 0), Handler)
        self.provider = provider
        self.requests = []
        self.actions = [
            ("write_file", {"path": "sample.py", "content": "value = 1\n"}),
            ("read_file", {"path": "sample.py"}),
            ("edit_file", {"path": "sample.py", "old_text": "value = 1", "new_text": "value = 2"}),
            ("shell", {"command": shlex.quote(sys.executable) + " -c " + shlex.quote("import sample; assert sample.value == 2; print('verified')")}),
        ]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        index = len(self.server.requests)
        self.server.requests.append((self.path, data))
        action = self.server.actions[index] if index < len(self.server.actions) else None
        streaming = data.get("stream", False)
        payload = self.anthropic(index, action, streaming) if self.server.provider == "anthropic" else self.openai(index, action, streaming)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream" if streaming else "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    @staticmethod
    def openai(index, action, streaming):
        text = "已验证 sample.value == 2"
        calls = [{"id": f"call_{index}", "type": "function", "function": {
            "name": action[0], "arguments": json.dumps(action[1], ensure_ascii=False)}}] if action else []
        finish = "tool_calls" if action else "stop"
        base = {"id": f"chat_{index}", "created": 1, "model": "local-test"}
        if not streaming:
            return json_bytes({**base, "object": "chat.completion", "choices": [{"index": 0, "finish_reason": finish,
                "message": {"role": "assistant", "content": "" if action else text, "tool_calls": calls}}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}})
        if action:
            args = calls[0]["function"]["arguments"]
            split = len(args) // 2
            deltas = [
                {"role": "assistant", "tool_calls": [{"index": 0, "id": f"call_{index}", "type": "function",
                  "function": {"name": action[0], "arguments": args[:split]}}]},
                {"tool_calls": [{"index": 0, "function": {"arguments": args[split:]}}]},
            ]
        else:
            deltas = [{"role": "assistant", "content": text[:4]}, {"content": text[4:]}]
        chunks = [{**base, "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": delta, "finish_reason": None}]} for delta in deltas]
        chunks.append({**base, "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": {}, "finish_reason": finish}]})
        return b"".join(b"data: " + json_bytes(chunk) + b"\n\n" for chunk in chunks) + b"data: [DONE]\n\n"

    @staticmethod
    def anthropic(index, action, streaming):
        block = {"type": "tool_use", "id": f"call_{index}", "name": action[0], "input": action[1]} if action else {"type": "text", "text": "已验证 sample.value == 2"}
        finish = "tool_use" if action else "end_turn"
        message = {"id": f"msg_{index}", "type": "message", "role": "assistant", "model": "local-test",
                   "content": [block], "stop_reason": finish, "stop_sequence": None,
                   "usage": {"input_tokens": 10, "output_tokens": 5}}
        if not streaming:
            return json_bytes(message)
        start = {**message, "content": [], "stop_reason": None, "usage": {"input_tokens": 10, "output_tokens": 0}}
        block_start = {**block, "input": {}} if action else {"type": "text", "text": ""}
        raw = json.dumps(action[1], ensure_ascii=False) if action else block["text"]
        mid = len(raw) // 2
        events = [
            {"type": "message_start", "message": start},
            {"type": "content_block_start", "index": 0, "content_block": block_start},
        ]
        for fragment in (raw[:mid], raw[mid:]):
            delta = {"type": "input_json_delta", "partial_json": fragment} if action else {"type": "text_delta", "text": fragment}
            events.append({"type": "content_block_delta", "index": 0, "delta": delta})
        events.extend([
            {"type": "content_block_stop", "index": 0},
            {"type": "message_delta", "delta": {"stop_reason": finish, "stop_sequence": None}, "usage": {"output_tokens": 5}},
            {"type": "message_stop"},
        ])
        return b"".join(b"event: " + event["type"].encode() + b"\ndata: " + json_bytes(event) + b"\n\n" for event in events)


class ProviderHTTPTests(unittest.TestCase):
    @patch.dict(os.environ, {"NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1,localhost"})
    def flow(self, provider, stream):
        if importlib.util.find_spec(provider) is None:
            self.skipTest(f"optional SDK not installed: {provider}")
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            server = Simulator(provider)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                config = Config(root, root / ".state", provider=provider, model="local-test", api_key="local-test-only",
                                base_url=f"http://127.0.0.1:{server.server_port}" + ("/v1" if provider == "openai" else ""), mode="auto", stream=stream,
                                max_turns=6, timeout=5).validate()
                store = Store(config)
                engine = None
                try:
                    displayed = []
                    engine = Engine(config, store, display=lambda kind, text: displayed.append((kind, text)))
                    result = engine.run("创建、读取、修改 sample.py，再执行断言验证")
                    self.assertEqual(result["status"], "completed", result)
                    self.assertEqual((root / "sample.py").read_text(), "value = 2\n")
                    outputs = [m for m in engine.messages if m["role"] == "tool"]
                    self.assertEqual(len(outputs), 4)
                    self.assertFalse(any(m["is_error"] for m in outputs), outputs)
                    self.assertEqual(json.loads(outputs[-1]["content"])["exit_code"], 0)
                    self.assertIn("verified", outputs[-1]["content"])
                    self.assertEqual(len(server.requests), 5)
                    self.assertEqual({path for path, _ in server.requests}, {"/v1/messages" if provider == "anthropic" else "/v1/chat/completions"})
                    final_wire = server.requests[-1][1]["messages"]
                    if provider == "openai":
                        self.assertEqual(sum(m["role"] == "tool" for m in final_wire), 4)
                    else:
                        self.assertEqual(sum(b.get("type") == "tool_result" for m in final_wire for b in m["content"]), 4)
                    if stream:
                        self.assertEqual("".join(text for kind, text in displayed if kind == "stream"), result["text"])
                    assert_protocol(engine.messages)
                finally:
                    if engine:
                        engine.close()
                    store.close()
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

    def test_anthropic_messages(self):
        self.flow("anthropic", False)

    def test_anthropic_stream(self):
        self.flow("anthropic", True)

    def test_openai_chat_completions(self):
        self.flow("openai", False)

    def test_openai_stream(self):
        self.flow("openai", True)


if __name__ == "__main__":
    unittest.main()
