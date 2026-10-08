"""测试用的最小 stdio MCP server：实现 initialize / tools.list / tools.call。

它不是 EdaCode 的运行时依赖，只用于验证 mcp.py 的握手、工具发现和调用路径。
"""
import json
import sys


def send(message):
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except ValueError:
            continue
        method = message.get("method")
        rid = message.get("id")
        if method == "initialize":
            send({"jsonrpc": "2.0", "id": rid, "result": {
                "protocolVersion": "2024-11-05", "capabilities": {"tools": {}},
                "serverInfo": {"name": "echo-fixture", "version": "0.0.1"}}})
        elif method == "notifications/initialized":
            continue
        elif method == "tools/list":
            send({"jsonrpc": "2.0", "id": rid, "result": {"tools": [
                {"name": "echo", "description": "回显传入文本",
                 "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}},
                                 "required": ["text"]}}]}})
        elif method == "tools/call":
            arguments = (message.get("params") or {}).get("arguments") or {}
            send({"jsonrpc": "2.0", "id": rid, "result": {
                "content": [{"type": "text", "text": "echo:" + str(arguments.get("text", ""))}],
                "isError": False}})
        elif rid is not None:
            send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "method not found"}})


if __name__ == "__main__":
    main()
