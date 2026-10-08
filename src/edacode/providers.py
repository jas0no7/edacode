"""供应商适配边界：内部使用普通 JSON，不保存 SDK 对象。"""
from dataclasses import dataclass, field
import json
import time
import uuid


@dataclass
class Reply:
    text: str = ""
    calls: list[dict] = field(default_factory=list)
    input_tokens: int = 0
    output_tokens: int = 0
    stop: str = "stop"

    def message(self):
        return {"role": "assistant", "content": self.text, "tool_calls": self.calls}


def anthropic_messages(messages):
    result = []
    for item in messages:
        role = item["role"]
        if role == "tool":
            role = "user"
            blocks = [{"type": "tool_result", "tool_use_id": item["tool_call_id"],
                       "content": item["content"], "is_error": item.get("is_error", False)}]
        else:
            blocks = [{"type": "text", "text": item["content"]}] if item.get("content") else []
            for call in item.get("tool_calls", []):
                args = call.get("arguments", {})
                if isinstance(args, str):
                    try:
                        args = json.loads(args)
                    except ValueError:
                        args = {"_invalid_json": args}
                if not isinstance(args, dict):
                    args = {"_invalid_input": args}
                blocks.append({"type": "tool_use", "id": call["id"], "name": call["name"], "input": args})
        if not blocks:
            blocks = [{"type": "text", "text": "(空响应)"}]
        if result and result[-1]["role"] == role:
            result[-1]["content"].extend(blocks)
        else:
            result.append({"role": role, "content": blocks})
    return result


def openai_messages(system, messages):
    result = [{"role": "system", "content": system}]
    for item in messages:
        row = {"role": item["role"], "content": item.get("content", "")}
        if item["role"] == "tool":
            row["tool_call_id"] = item["tool_call_id"]
        if item.get("tool_calls"):
            row["tool_calls"] = [{"id": c["id"], "type": "function", "function": {
                "name": c["name"], "arguments": json.dumps(c["arguments"], ensure_ascii=False)
                if not isinstance(c["arguments"], str) else c["arguments"]}} for c in item["tool_calls"]]
        result.append(row)
    return result


class Provider:
    def __init__(self, config):
        self.config = config
        kwargs = {"api_key": config.api_key, "timeout": config.timeout, "max_retries": 0}
        if config.base_url:
            kwargs["base_url"] = config.base_url
        if config.provider == "anthropic":
            try:
                from anthropic import Anthropic
            except ImportError as exc:
                raise ValueError("Anthropic provider 需要安装 SDK：pip install anthropic（或 pip install -e .）") from exc
            self.client = Anthropic(**kwargs)
        else:
            try:
                from openai import OpenAI
            except ImportError as exc:
                raise ValueError("OpenAI provider 需要安装：pip install -e '.[openai]'") from exc
            self.client = OpenAI(**kwargs)

    def complete(self, system, messages, tools, on_text=None) -> Reply:
        # 只重试尚未显示任何文本的网络/限流失败，绝不重放工具。
        emitted = [False]
        def emit(text):
            if text and on_text:
                emitted[0] = True
                on_text(text)
        for attempt in range(3):
            try:
                if self.config.provider == "anthropic":
                    return self._anthropic(system, messages, tools, emit if on_text else None)
                return self._openai(system, messages, tools, emit if on_text else None)
            except Exception as exc:
                code = getattr(exc, "status_code", None)
                transient = code in {408, 429, 500, 502, 503, 504, 529} or type(exc).__name__ in {"APIConnectionError", "APITimeoutError"}
                if not transient or emitted[0] or attempt == 2:
                    raise
                time.sleep(2 ** attempt)
        raise RuntimeError("unreachable")

    def _anthropic(self, system, messages, tools, on_text):
        kwargs = dict(model=self.config.model, system=system, messages=anthropic_messages(messages),
                      max_tokens=self.config.max_tokens)
        if tools:
            kwargs["tools"] = tools
        if self.config.stream and on_text:
            with self.client.messages.stream(**kwargs) as stream:
                for chunk in stream.text_stream:
                    on_text(chunk)
                response = stream.get_final_message()
        else:
            response = self.client.messages.create(**kwargs)
        text = "\n".join(b.text for b in response.content if b.type == "text")
        calls = [{"id": b.id, "name": b.name, "arguments": b.input}
                 for b in response.content if b.type == "tool_use"]
        usage = response.usage
        return Reply(text, calls, usage.input_tokens + (getattr(usage, "cache_read_input_tokens", 0) or 0)
                     + (getattr(usage, "cache_creation_input_tokens", 0) or 0), usage.output_tokens, response.stop_reason or "stop")

    def _openai(self, system, messages, tools, on_text):
        kwargs = dict(model=self.config.model, messages=openai_messages(system, messages), max_tokens=self.config.max_tokens)
        if tools:
            kwargs["tools"] = [{"type": "function", "function": {"name": t["name"], "description": t["description"],
                                "parameters": t["input_schema"]}} for t in tools]
        if not (self.config.stream and on_text):
            response = self.client.chat.completions.create(**kwargs)
            message = response.choices[0].message
            usage = response.usage
            return Reply(message.content or "", [{"id": c.id, "name": c.function.name, "arguments": c.function.arguments}
                         for c in message.tool_calls or []], getattr(usage, "prompt_tokens", 0) or 0,
                         getattr(usage, "completion_tokens", 0) or 0, response.choices[0].finish_reason or "stop")
        text, calls, stop, in_tokens, out_tokens = [], {}, "stop", 0, 0
        # 不强制 stream_options，兼容不支持 usage chunk 的网关；这时统计为 0。
        stream = self.client.chat.completions.create(**kwargs, stream=True)
        try:
            for chunk in stream:
                if getattr(chunk, "usage", None):
                    in_tokens, out_tokens = chunk.usage.prompt_tokens, chunk.usage.completion_tokens
                if not chunk.choices:
                    continue
                choice = chunk.choices[0]
                stop = choice.finish_reason or stop
                delta = choice.delta
                if delta.content:
                    text.append(delta.content)
                    on_text(delta.content)
                for part in delta.tool_calls or []:
                    call = calls.setdefault(part.index, {"id": "", "name": "", "arguments": ""})
                    if part.id:
                        call["id"] = part.id
                    if part.function:
                        call["name"] += part.function.name or ""
                        call["arguments"] += part.function.arguments or ""
        finally:
            stream.close()
        return Reply("".join(text), [calls[i] for i in sorted(calls)], in_tokens, out_tokens, stop)

    def close(self):
        self.client.close()


class MockProvider:
    """离线演示是真实工具调用；回复是固定脚本，不模拟模型智能。"""
    def complete(self, system, messages, tools, on_text=None):
        if "GOAL_EVALUATOR" in system:
            return Reply('{"ok": false, "reason": "mock 无法判断真实任务完成", "impossible": true}')
        if "CONTEXT_SUMMARIZER" in system:
            return Reply("离线摘要：保留最近消息；更早的完整记录可通过 read_artifact 恢复。")
        last = messages[-1]
        if last["role"] == "user":
            call = {"id": "mock_" + uuid.uuid4().hex[:12], "name": "list_files", "arguments": {"pattern": "**/*"}}
            return Reply("离线演示：调用 list_files 查看工作目录。", [call])
        return Reply("离线演示完成。真实文件列表：\n" + last.get("content", "")[:2500] + "\n配置 API 后可执行自然语言编码任务。")

    def close(self):
        pass


def make_provider(config):
    return MockProvider() if config.provider == "mock" else Provider(config)
