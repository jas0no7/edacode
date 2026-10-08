"""MCP（Model Context Protocol）stdio 客户端。

把外部 MCP server 通过 newline-delimited JSON-RPC 暴露的工具并入 EdaCode 的工具表。
工具名统一命名空间为 ``mcp__<server>__<tool>``；外部工具定义不等于授权，仍需走 Policy 审批。
"""
import json
import os
import subprocess
import threading
import time

PROTOCOL_VERSION = "2024-11-05"


class MCPError(Exception):
    pass


class MCPServer:
    """单个 stdio MCP server 的生命周期与请求/响应配对。"""

    def __init__(self, name, spec, cwd, timeout=20):
        self.name, self.spec, self.cwd, self.timeout = name, spec, cwd, timeout
        self.process = None
        self.pending = {}
        self.lock = threading.Lock()
        self.write_lock = threading.Lock()
        self.next_id = 0
        self.tools = []
        self.stderr = bytearray()

    def start(self):
        command = self.spec.get("command")
        args = self.spec.get("args", [])
        if not isinstance(command, str) or not command.strip():
            raise MCPError(f"mcp server {self.name} 缺少 command")
        if not isinstance(args, list):
            raise MCPError(f"mcp server {self.name} 的 args 必须是数组")
        env = dict(os.environ)
        env.update({str(k): str(v) for k, v in (self.spec.get("env") or {}).items()})
        try:
            self.process = subprocess.Popen(
                [command, *[str(a) for a in args]], cwd=self.cwd, env=env,
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, encoding="utf-8", errors="replace", bufsize=1)
        except OSError as exc:
            raise MCPError(f"无法启动 {self.name}：{exc}") from exc
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()
        self.request("initialize", {"protocolVersion": PROTOCOL_VERSION, "capabilities": {},
                                    "clientInfo": {"name": "edacode", "version": "0.1.0"}})
        self.notify("notifications/initialized", {})
        listing = self.request("tools/list", {})
        raw = listing.get("tools", []) if isinstance(listing, dict) else []
        self.tools = [t for t in raw if isinstance(t, dict) and isinstance(t.get("name"), str)]
        return self

    def request(self, method, params):
        if not self.process or self.process.poll() is not None:
            raise MCPError(f"mcp server {self.name} 未运行；stderr: {self.stderr_tail()}")
        with self.lock:
            self.next_id += 1
            rid = self.next_id
            entry = {"event": threading.Event(), "result": None, "error": None}
            self.pending[rid] = entry
        self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        if not entry["event"].wait(self.timeout):
            self.pending.pop(rid, None)
            raise MCPError(f"mcp server {self.name} 响应超时：{method}")
        self.pending.pop(rid, None)
        if entry["error"] is not None:
            raise MCPError(f"mcp server {self.name} 的 {method} 失败：{entry['error']}")
        return entry["result"]

    def notify(self, method, params):
        self._send({"jsonrpc": "2.0", "method": method, "params": params})

    def call(self, tool, arguments):
        result = self.request("tools/call", {"name": tool, "arguments": arguments})
        return format_result(result)

    def _send(self, message):
        line = json.dumps(message, ensure_ascii=False)
        try:
            with self.write_lock:
                self.process.stdin.write(line + "\n")
                self.process.stdin.flush()
        except (OSError, ValueError) as exc:
            raise MCPError(f"向 {self.name} 写入失败：{exc}") from exc

    def _read_stdout(self):
        try:
            while True:
                line = self.process.stdout.readline()
                if not line:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    message = json.loads(line)
                except ValueError:
                    continue
                rid = message.get("id")
                if rid is None:
                    continue
                entry = self.pending.get(rid)
                if entry is None:
                    continue
                if "error" in message:
                    entry["error"] = message["error"]
                else:
                    entry["result"] = message.get("result")
                entry["event"].set()
        finally:
            # 进程结束时唤醒所有等待者，避免调用方永久阻塞。
            for entry in list(self.pending.values()):
                if entry["error"] is None:
                    entry["error"] = "server 已退出"
                entry["event"].set()

    def _read_stderr(self):
        try:
            for chunk in iter(lambda: self.process.stderr.read(1), ""):
                if len(self.stderr) < 8192:
                    self.stderr.extend(chunk.encode("utf-8", "replace"))
        except (OSError, ValueError):
            pass

    def stderr_tail(self):
        return self.stderr.decode("utf-8", "replace")[-500:].strip() or "无输出"

    def close(self):
        if not self.process:
            return
        try:
            if self.process.stdin:
                self.process.stdin.close()
        except (OSError, ValueError):
            pass
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)


def format_result(result):
    if not isinstance(result, dict):
        return json.dumps(result, ensure_ascii=False)
    parts = []
    for item in result.get("content", []):
        if isinstance(item, dict) and item.get("type") == "text":
            parts.append(str(item.get("text", "")))
        else:
            parts.append(json.dumps(item, ensure_ascii=False))
    text = "\n".join(parts)
    if not text:
        text = json.dumps(result, ensure_ascii=False)
    return text


def tool_spec(full_name, server, tool):
    schema = tool.get("inputSchema")
    if not isinstance(schema, dict) or schema.get("type") != "object":
        schema = {"type": "object", "properties": {}}
    else:
        schema = dict(schema)
        if not isinstance(schema.get("properties"), dict):
            schema["properties"] = {}
    description = str(tool.get("description") or "").strip() or "外部 MCP 工具"
    return {"name": full_name, "description": f"[MCP {server}] {description}"[:1024], "input_schema": schema}


class MCPManager:
    """读取工作区 mcp.json，聚合外部工具；单个 server 失败不影响其他 server。"""

    def __init__(self, root, display=lambda *a: None, timeout=20):
        self.root, self.display, self.timeout = root, display, timeout
        self.servers = {}
        self.definitions = {}
        self.routes = {}
        self.errors = []

    def load(self):
        for name, spec in self._read_config().items():
            if not isinstance(spec, dict):
                self.errors.append(f"{name}: 配置必须是对象")
                continue
            server = MCPServer(name, spec, str(self.root), self.timeout)
            try:
                server.start()
            except Exception as exc:
                server.close()
                self.errors.append(f"{name}: {exc}")
                self.display("info", f"MCP server {name} 不可用：{exc}")
                continue
            self.servers[name] = server
            for tool in server.tools:
                full = f"mcp__{name}__{tool['name']}"
                self.definitions[full] = tool_spec(full, name, tool)
                self.routes[full] = (server, tool["name"])
        return self

    def _read_config(self):
        for path in (self.root / "mcp.json", self.root / ".edacode" / "mcp.json"):
            if not path.is_file():
                continue
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError) as exc:
                self.errors.append(f"{path.name}: 解析失败 {exc}")
                continue
            servers = data.get("mcpServers", data) if isinstance(data, dict) else None
            if isinstance(servers, dict):
                return servers
            self.errors.append(f"{path.name}: 缺少 mcpServers 对象")
        return {}

    def call(self, full_name, arguments):
        route = self.routes.get(full_name)
        if route is None:
            raise MCPError("未知 MCP 工具：" + full_name)
        server, tool = route
        return server.call(tool, arguments)

    def close(self):
        for server in self.servers.values():
            try:
                server.close()
            except Exception:
                pass
        self.servers.clear()
