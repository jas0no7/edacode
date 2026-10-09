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


def _file(inner, tools):
    target = inner.strip()
    try:
        path = tools.path(target)
        if path.is_dir():
            return _listing(tools, target)
        return f"\n[文件 {target}]\n" + tools.read_text(target, FILE_BLOCK)
    except (ValueError, OSError, PermissionError) as exc:
        return f"[@{target} 无法注入：{exc}]"


def inject_files(text, tools, display=lambda *a: None):
    """把 ``@{path}`` 替换为文件内容或目录清单。"""
    return _replace(text, _blocks(text, "@{"), lambda inner: _file(inner, tools))


def _shell(inner, tools, display):
    command = inner.strip()
    display("tool", "自定义命令注入 shell：" + command)
    output, error = tools.call("shell", {"command": command})
    status = "[退出状态：失败]" if error else ""
    return f"\n[命令 `{command}` 输出{status}]\n{output}"


def inject_shell(text, tools, display=lambda *a: None):
    """把 ``!{cmd}`` 替换为命令输出；执行路径与 shell 工具完全一致（含审批）。"""
    return _replace(text, _blocks(text, "!{"), lambda inner: _shell(inner, tools, display))


def substitute(text, arguments, shell=False):
    """替换 $ARGUMENTS / {{args}} / $1..$9；$N 越界时保留空串。"""
    parts = _positional(arguments)

    def placeholder(match):
        token = match.group(1) or "args"
        if token.casefold() in {"arguments", "args"}:
            value = arguments
        else:
            index = int(token)
            value = parts[index - 1] if 1 <= index <= len(parts) else ""
        return shlex.quote(value) if shell else value

    pattern = re.compile(r"\$\{?(\d+|ARGUMENTS)\}?|\{\{args\}\}", re.IGNORECASE)
    if shell and pattern.search(text):
        if "<<" in text:
            raise ValueError("shell 模板参数不支持 heredoc；请使用独立参数")
        cursor, quote, escaped = 0, None, False
        for match in pattern.finditer(text):
            for char in text[cursor:match.start()]:
                if escaped:
                    escaped = False
                elif char == "\\" and quote != "'":
                    escaped = True
                elif quote:
                    if char == quote:
                        quote = None
                elif char in "'\"`":
                    quote = char
            if quote or escaped:
                raise ValueError("shell 模板占位符请放在引号外，EdaCode 会自动转义参数")
            cursor = match.end()
    return pattern.sub(placeholder, text)


def _has_placeholder(text):
    return bool(re.search(r"\$\{?(\d+|ARGUMENTS)\}?|\{\{args\}\}", text, re.IGNORECASE))


def inject_references(text, tools, display=lambda *a: None):
    """普通输入里的 ``@path`` 引用：只替换能解析到工作区内真实路径的 token。"""
    pattern = re.compile(r"(?<![\w@])@([^\s@]+)")

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

    只解释模板中的注入语法。文件和命令输出中的 @{...}/!{...} 都是普通数据，
    不能递归展开成另一次读取或执行。
    """
    text = command["body"]
    spans = [(start, end, marker) for marker in ("@{", "!{")
             for start, end, _ in _blocks(text, marker)]
    previous_end = -1
    for start, end, _ in sorted(spans):
        if start < previous_end:
            raise ValueError("命令模板不支持嵌套的文件/shell 注入")
        previous_end = end
    pieces, cursor = [], 0
    for start, end, marker in sorted(spans):
        pieces.append(substitute(text[cursor:start], arguments))
        inner = text[start + 2:end - 1]
        if marker == "@{":
            pieces.append(_file(substitute(inner, arguments), tools))
        else:
            # 参数按一个 shell 字面量传入，文件名里的分号等不能成为新命令。
            # Windows 的 cmd.exe 无 POSIX quoting；有参数的 shell 模板要求 bash。
            from .compat import find_shell
            if _has_placeholder(inner) and not find_shell():
                raise ValueError("shell 模板参数转义需要 bash；请安装 Git Bash 或使用固定命令")
            pieces.append(_shell(substitute(inner, arguments, shell=True), tools, display))
        cursor = end
    text = "".join(pieces) + substitute(text[cursor:], arguments)
    if arguments.strip() and not _has_placeholder(command["body"]):
        text = text + "\n\n" + arguments
    return text
