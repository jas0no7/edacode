"""交互 REPL 与单次 JSON 输出共用同一个 Engine。"""
import argparse
from datetime import datetime
import json
import random
import re
import sys

from . import __version__, ui
from .commands import discover as discover_commands, expand, inject_references
from .config import load_config
from .engine import Engine
from .storage import Store, list_sessions


HELP = """/help                         帮助
/status                       会话、模式、token、计划、Goal
/mode plan|ask|edit|auto       切换权限
/model <模型ID>               切换模型（provider 在启动时选择）
/goal <完成条件>              设置目标并立即执行；不带参数查看，clear 清除
/memory list|add <文本>|clear  用户明确保存的项目记忆
/sessions                     列出会话；启动时 --resume <ID> 恢复
/jobs                         查看当前后台作业
/cancel <job_id>              停止当前会话的后台作业
/diff                         查看专用工具的文件变更（不包含 shell 写入）
/undo                         撤销最近一次文件变更，遇到外部修改会拒绝
/checkpoint [说明]            手动记录检查点（文件 + 对话 + 计划 + Goal）
/restore [ID|latest]          列出或回滚到检查点；外部改过的文件会跳过
/compact                      归档旧上下文并保留事实摘要
/clear                        归档后清空对话和计划、清除 Goal
/tools                        可用工具
/mcp                          外部 MCP server 与工具状态
/commands list|reload         自定义命令列表 / 重新扫描
/quit                         退出，结束本进程启动的后台作业
行尾反斜杠可输入多行。Ctrl-C 中断当前工作，返回输入；输入处 Ctrl-C 退出。
plan 禁止文件写入和 shell；ask 逐项确认；edit 自动写文件、shell 确认；auto 自动执行。
输入里的 @路径 会注入文件内容或目录清单；自定义命令见 .edacode/commands/。
"""


def safe_terminal(text):
    text = re.sub(r"\x1b\][^\x07]*(?:\x07|\x1b\\)", "", str(text))
    text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)
    return re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text)


class Terminal:
    def __init__(self, quiet=False, interactive=True, palette=None):
        self.quiet, self.interactive, self.streaming = quiet, interactive, False
        self.palette = palette or ui.PLAIN

    def display(self, kind, text):
        if self.quiet:
            return
        text = safe_terminal(text)
        p = self.palette
        if kind == "stream":
            if not self.streaming:
                print("\n" + p.accent + "助手" + p.reset + " ", end="", flush=True)
                self.streaming = True
            print(text, end="", flush=True)
        elif kind == "stream_end":
            self.streaming = False
            print(flush=True)
        elif kind == "assistant":
            print("\n" + p.accent + "助手" + p.reset + " " + text, flush=True)
        elif kind == "error":
            print(f"\n{p.red}[error]{p.reset} {text}", file=sys.stderr, flush=True)
        else:
            print(f"\n{p.muted}[{kind}]{p.reset} {text}", file=sys.stderr, flush=True)

    def confirm(self, name, detail):
        if not self.interactive or not sys.stdin.isatty():
            return False
        print(f"\n请求执行 {safe_terminal(name)}：\n{safe_terminal(detail)}", file=sys.stderr)
        # 不截断审批内容；模型可能把有副作用的尾部藏在很长的命令后。
        try:
            return input("允许此次操作？[y/N] ").strip().casefold() in {"y", "yes"}
        except EOFError:
            return False


def parser():
    p = argparse.ArgumentParser(description="EdaCode 独立交互式编码 agent")
    p.add_argument("query", nargs="*", help="启动任务，完成后继续交互")
    p.add_argument("-p", "--prompt", help="单次执行并退出，不从 stdin 读取审批")
    p.add_argument("--json", action="store_true", help="配合 -p，stdout 只输出一个 JSON 对象")
    p.add_argument("--workspace", default=".", help="默认当前目录")
    p.add_argument("--env-file", help="默认 WORKSPACE/.env")
    p.add_argument("--home", help="状态目录，默认 ~/.edacode")
    p.add_argument("--provider", choices=["anthropic", "openai", "mock"])
    p.add_argument("--model")
    p.add_argument("--mode", choices=["plan", "ask", "edit", "auto"])
    p.add_argument("--resume", nargs="?", const="latest", help="恢复指定 ID 或最近主会话")
    p.add_argument("--max-turns", type=int)
    p.add_argument("--no-stream", action="store_true")
    p.add_argument("--no-banner", action="store_true", help="不显示欢迎屏，只打印一行启动信息")
    p.add_argument("--version", action="version", version=__version__)
    return p


def command(text, config, store, engine):
    parts = text.split(maxsplit=1)
    name, rest = parts[0], parts[1].strip() if len(parts) > 1 else ""
    if name == "/help":
        return HELP
    if name == "/status":
        return json.dumps({"session": store.id, "workspace": str(config.workspace), "mode": engine.policy.mode,
                           "provider": config.provider, "model": config.model, "messages": len(engine.messages),
                           "usage": store.data["usage"], "goal": engine.goal, "todos": store.data["todos"],
                           "checkpoints": len(store.data.get("checkpoints", [])),
                           "changes": len(store.data["changes"])}, ensure_ascii=False, indent=2)
    if name == "/mode":
        if rest not in {"plan", "ask", "edit", "auto"}:
            raise ValueError("用法：/mode plan|ask|edit|auto")
        config.mode = engine.policy.mode = rest
        store.event("mode_changed", mode=rest)
        return f"权限模式：{rest}" + ("；shell 以当前用户权限执行，工作目录不是沙箱。" if rest == "auto" else "")
    if name == "/model":
        if not rest:
            return config.model
        config.model = rest
        return "当前模型：" + rest
    if name == "/goal":
        if not rest:
            return json.dumps(engine.goal, ensure_ascii=False, indent=2)
        if rest.casefold() in {"clear", "off", "stop", "none", "cancel"}:
            engine.clear_goal()
            return "Goal 已清除"
        engine.set_goal(rest)
        return engine.run(rest)
    if name == "/memory":
        if rest == "list":
            return json.dumps(engine.memory.items, ensure_ascii=False, indent=2)
        if rest == "clear":
            engine.memory.update(clear=True)
            return "当前工作区记忆已清除"
        if rest.startswith("add ") and rest[4:].strip():
            engine.memory.update(text=rest[4:].strip())
            return "记忆已保存"
        raise ValueError("用法：/memory list|add <文本>|clear")
    if name == "/sessions":
        return "\n".join(f"{x['id']}  {datetime.fromtimestamp(x['updated']).isoformat(timespec='seconds')}  {safe_terminal(x['title'])}"
                         for x in list_sessions(config)) or "无会话"
    if name == "/jobs":
        return json.dumps([j.poll() for j in engine.tools.processes.jobs.values()], ensure_ascii=False, indent=2)
    if name == "/cancel":
        return json.dumps(engine.tools.processes.get(rest).stop(), ensure_ascii=False)
    if name == "/undo":
        result = engine.tools.undo()
        engine.messages.append({"role": "user", "content": "[用户手动撤销变更] " + result + "；继续编辑前重新读取文件。"})
        store.save()
        return result
    if name == "/diff":
        return "\n\n".join(f"[{x['status']}{'/已撤销' if x['undone'] else ''}] {x['path']}\n{x['diff']}"
                            for x in store.data["changes"][-10:]) or "无专用工具文件变更"
    if name == "/checkpoint":
        return "已创建检查点：" + engine.store.make_checkpoint(rest)
    if name == "/restore":
        index = store.data.get("checkpoints", [])
        if not rest:
            return "\n".join(
                f"{x['id']}  [{x['kind']}] {datetime.fromtimestamp(x['time']).isoformat(timespec='seconds')}"
                f"  {safe_terminal(x['label'])}  (消息 {x['messages_len']} / 变更 {x['changes_len']})"
                for x in reversed(index)) or "当前会话没有检查点"
        result = engine.restore(index[-1]["id"] if rest == "latest" else rest)
        lines = [f"已回滚检查点 {result['id']}", result["conversation"],
                 "文件已回滚：" + (", ".join(result["reverted"]) or "无")]
        if result["skipped"]:
            lines.append("跳过：" + "; ".join(f"{path}（{why}）" for path, why in result["skipped"]))
        return "\n".join(lines)
    if name == "/compact":
        return "上下文已压缩" if engine._context(force=True) else "无须压缩"
    if name == "/tools":
        return "\n".join(f"- {n}: {v['description']}" for n, v in engine.tools.definitions.items())
    if name == "/mcp":
        mcp = engine.tools.mcp
        if mcp is None:
            return "只读子 agent 不加载 MCP"
        rows = [f"- {server.name}: {len(server.tools)} 个工具" for server in mcp.servers.values()]
        rows += ["- 加载失败：" + err for err in mcp.errors]
        return "\n".join(rows) or "未配置 mcp.json（工作区根目录或 .edacode/mcp.json）"
    if name == "/commands":
        if rest == "reload":
            engine.tools.commands = discover_commands(config.workspace, config.home)
            return f"已重新扫描：{len(engine.tools.commands)} 个自定义命令"
        if rest not in {"", "list"}:
            raise ValueError("用法：/commands list|reload")
        rows = [f"- /{key}  [{item['source']}] {item['description']}"
                + (f"  参数：{item['argument_hint']}" if item["argument_hint"] else "")
                for key, item in sorted(engine.tools.commands.items())]
        return "\n".join(rows) or "无自定义命令；在 .edacode/commands/ 或 <home>/commands/ 放 Markdown 文件"
    if name == "/clear":
        archive = store.artifact(json.dumps(engine.messages, ensure_ascii=False), "history")
        engine.messages.clear()
        store.data["todos"] = []
        # 历史被清空，旧检查点无法再按 messages_len 回滚对话，一并清除。
        store.data["checkpoints"] = []
        engine.clear_goal()
        store.save()
        return "对话已清空，旧消息归档：" + archive
    if name.startswith("/") and name[1:] in engine.tools.commands:
        prompt = expand(engine.tools.commands[name[1:]], rest, engine.tools, engine.display)
        engine.display("info", f"自定义命令 /{name[1:]} 展开为 {len(prompt)} 字符")
        return engine.run(prompt)
    raise ValueError("未知命令，输入 /help 查看帮助")


def main(argv=None):
    # Windows 控制台默认不是 UTF-8；用 replace 兜底，避免中文/符号打印直接崩溃。
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError, OSError):
            pass
    p = parser()
    args = p.parse_args(argv)
    if args.json and args.prompt is None:
        p.error("--json 需要同时提供 -p")
    if args.prompt is not None and args.query:
        p.error("位置任务与 -p 不能同时使用")
    args.no_stream = args.no_stream or args.json
    ui.enable_windows_ansi()
    palette = ui.Palette(ui.supports_color(sys.stdout))
    console = Terminal(quiet=args.json, interactive=args.prompt is None, palette=palette)
    store = engine = None
    try:
        config = load_config(args)
        store = Store(config, args.resume)
        engine = Engine(config, store, display=console.display, confirm=console.confirm)
        def submit(text):
            try:
                if text.startswith("/"):
                    result = command(text, config, store, engine)
                else:
                    result = engine.run(inject_references(text, engine.tools, console.display))
                if isinstance(result, str):
                    console.display("info", result)
                    result = {"status": "completed", "text": result, "session": store.id}
                elif result.get("reason"):
                    console.display(result["status"], result["reason"])
                return result
            except Exception as exc:
                result = {"status": "error", "text": "", "reason": engine.error_text(exc), "session": store.id}
                console.display("error", result["reason"])
                return result
        if args.prompt is not None:
            result = submit(args.prompt)
            if args.json:
                print(json.dumps({**result, "usage": store.data["usage"]}, ensure_ascii=False))
            return 0 if result["status"] == "completed" else 130 if result["status"] == "cancelled" else 1
        if args.no_banner:
            print(f"EdaCode {__version__} | {config.provider}/{config.model or 'mock'} | {config.mode}"
                  f"\n工作区：{config.workspace}\n会话：{store.id}\n/help 查看命令；/quit 退出。", flush=True)
        else:
            print(ui.welcome(config, engine.tools, palette, tip=random.choice(ui.TIPS)), flush=True)
        try:
            import readline  # macOS/Linux 自带行编辑和内存输入历史。
        except ImportError:
            pass
        pending = " ".join(args.query).strip()
        while True:
            try:
                text = pending or input(ui.prompt_text(palette, config.mode)).strip()
                pending = ""
                while text.endswith("\\"):
                    text = text[:-1] + "\n" + input(f"{palette.faint}… {palette.reset}").strip()
            except (EOFError, KeyboardInterrupt):
                print("\n会话已保存。")
                break
            if text.casefold() in {"q", "quit", "exit", "/quit", "/exit"}:
                break
            if text:
                submit(text)
        return 0
    except Exception as exc:
        reason = engine.error_text(exc) if engine else f"{type(exc).__name__}: {exc}"
        if args.json:
            print(json.dumps({"status": "error", "reason": reason}, ensure_ascii=False))
        else:
            print("EdaCode 启动失败：" + safe_terminal(reason), file=sys.stderr)
        return 2
    finally:
        try:
            if engine:
                engine.close()
        finally:
            if store:
                store.close()
