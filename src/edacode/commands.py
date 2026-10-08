"""自定义斜杠命令与 @ 引用注入。

借鉴 Gemini CLI 的 custom commands 与 Qwen Code / Claude Code 的 Markdown 命令：
把常用的长 prompt 固化成文件，并可把文件内容或命令输出注入到 prompt 里。

- 位置：项目 ``<workspace>/.edacode/commands/`` 优先于用户 ``<home>/commands/``。
- 命名：子目录用 ``:`` 连接，``git/commit.md`` -> ``/git:commit``。
- 参数：``$ARGUMENTS`` / ``{{args}}`` 注入全部参数，``$1``..``$9`` 注入位置参数。
- 注入：``@{path}`` 注入文件内容或目录清单；``!{cmd}`` 注入命令输出（走 Policy 审批）。
- 正文不含占位符时，参数会追加到 prompt 末尾（与 Gemini CLI 的默认行为一致）。

本模块不直接执行 shell：``!{...}`` 通过 ``tools.call('shell', ...)`` 走完整的校验、
权限和进程管理，因此 plan 模式会被拒绝，ask/edit 模式需要用户批准。
"""
import re
import shlex

FILE_BLOCK = 100_000
LIST_LIMIT = 500


def parse(path):
    """解析 Markdown 命令文件，返回 (meta, body)。支持可选的 --- frontmatter。"""
    text = path.read_text(encoding="utf-8")
    meta = {}
    body = text
    if text.startswith("---"):
        lines = text.splitlines()
        for index in range(1, len(lines)):
            if lines[index].strip() == "---":
                for line in lines[1:index]:
                    if ":" in line:
                        key, value = line.split(":", 1)
                        meta[key.strip().lower()] = value.strip().strip("\"'")
                body = "\n".join(lines[index + 1:])
                break
    return meta, body.strip()


def discover(root, home):
    """扫描用户与项目命令目录；同名时项目命令覆盖用户命令。"""
    commands = {}
    for base, source in ((home / "commands", "user"), (root / ".edacode" / "commands", "project")):
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("*.md")):
            try:
                if path.stat().st_size > 100_000:
                    continue
                meta, body = parse(path)
            except (OSError, UnicodeError):
                continue
            name = ":".join(path.relative_to(base).with_suffix("").parts)
            commands[name] = {
                "name": name, "source": source, "path": path, "body": body,
                "description": meta.get("description", "") or f"自定义命令 {name}",
                "argument_hint": meta.get("argument-hint", ""),
            }
    return commands


def _blocks(text, marker):
    """找出 marker 后花括号配平的片段，返回 [(start, end, inner)]。"""
    spans, index = [], 0
    while True:
        index = text.find(marker, index)
        if index < 0:
            break
        depth, cursor = 1, index + 2
        while cursor < len(text):
            if text[cursor] == "{":
                depth += 1
            elif text[cursor] == "}":
                depth -= 1
                if depth == 0:
                    break
            cursor += 1
        if cursor >= len(text):
            break
        spans.append((index, cursor + 1, text[index + 2:cursor]))
        index = cursor + 1
    return spans


def _replace(text, spans, render):
    for start, end, inner in reversed(spans):
        text = text[:start] + render(inner) + text[end:]
    return text


def _positional(arguments):
    try:
        return shlex.split(arguments)
    except ValueError:
        return arguments.split()


def _listing(tools, target):
    """目录清单：按 POSIX 前缀过滤，避免 Windows 反斜杠导致匹配不到。"""
    prefix = target.replace("\\", "/").strip("/") + "/"
    rows = [p for p in tools.files("**/*") if p.startswith(prefix)][:LIST_LIMIT]
    return f"\n[目录 {target} 共 {len(rows)} 项]\n" + "\n".join(rows)


def inject_files(text, tools, display=lambda *a: None):
    """把 ``@{path}`` 替换为文件内容或目录清单。"""
    def render(inner):
        target = inner.strip()
        try:
            path = tools.path(target)
        except (ValueError, PermissionError) as exc:
            return f"[@{target} 无法注入：{exc}]"
        try:
            if path.is_dir():
                return _listing(tools, target)
            return f"\n[文件 {target}]\n" + tools.read_text(target, FILE_BLOCK)
        except (ValueError, OSError, PermissionError) as exc:
            return f"[@{target} 无法注入：{exc}]"
    return _replace(text, _blocks(text, "@{"), render)


def inject_shell(text, tools, display=lambda *a: None):
    """把 ``!{cmd}`` 替换为命令输出；执行路径与 shell 工具完全一致（含审批）。"""
    def render(inner):
        command = inner.strip()
        display("tool", "自定义命令注入 shell：" + command)
        output, error = tools.call("shell", {"command": command})
        status = "[退出状态：失败]" if error else ""
        return f"\n[命令 `{command}` 输出{status}]\n{output}"
    return _replace(text, _blocks(text, "!{"), render)


def substitute(text, arguments):
    """替换 $ARGUMENTS / {{args}} / $1..$9；$N 越界时保留空串。"""
    parts = _positional(arguments)

    def placeholder(match):
        token = match.group(1) or match.group(2)
        if token.casefold() in {"arguments", "args"}:
            return arguments
        index = int(token)
        return parts[index - 1] if 1 <= index <= len(parts) else ""

    pattern = re.compile(r"\$\{?(\d+|ARGUMENTS)\}?|\{\{args\}\}", re.IGNORECASE)
    return pattern.sub(placeholder, text)


def _has_placeholder(text):
    return bool(re.search(r"\$\{?(\d+|ARGUMENTS)\}?|\{\{args\}\}", text, re.IGNORECASE))


def inject_references(text, tools, display=lambda *a: None):
    """普通输入里的 ``@path`` 引用：只替换能解析到工作区内真实路径的 token。"""
    pattern = re.compile(r"@([^\s@]+)")

    def render(match):
        token = match.group(1).rstrip(".,;:!?，。；：！？")
        if not token or token.startswith("{"):
            return match.group(0)
        try:
            path = tools.path(token)
        except (ValueError, PermissionError):
            return match.group(0)
        if not path.exists():
            return match.group(0)
        try:
            if path.is_dir():
                return _listing(tools, token)
            return f"\n[文件 {token}]\n" + tools.read_text(token, FILE_BLOCK)
        except (ValueError, OSError, PermissionError):
            return match.group(0)

    return pattern.sub(render, text)


def expand(command, arguments, tools, display=lambda *a: None):
    """把自定义命令展开成最终 prompt。

    顺序为 参数替换 -> 文件注入 -> shell 注入：先替换参数，可以让参数用在 ``!{...}``
    里；后注入内容，避免被注入的文件正文再被当成占位符二次替换。
    """
    text = substitute(command["body"], arguments)
    text = inject_files(text, tools, display)
    text = inject_shell(text, tools, display)
    if arguments.strip() and not _has_placeholder(command["body"]):
        text = text + "\n\n" + arguments
    return text
