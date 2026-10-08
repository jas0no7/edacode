"""工具注册、参数校验、文件变更预览与冲突检测。"""
import base64
import difflib
import fnmatch
import json
import os
from pathlib import Path
import re
import stat

from .storage import atomic_write, digest, encode
from .processes import Processes
from .permissions import check_command
from .mcp import MCPManager
from .commands import discover as discover_commands


def glob_match(relative, pattern):
    """glob 匹配：``*``/``?`` 不跨目录，``**`` 匹配零层或多层目录。

    fnmatch 不把 ``**`` 当特殊符号，导致 ``pkg/**/*`` 匹配不到 ``pkg/mod.py``；
    这里显式翻译成等价正则，语义与 shell/glob 一致。
    """
    regex, index = "", 0
    while index < len(pattern):
        char = pattern[index]
        if char == "*":
            if pattern.startswith("**/", index):
                regex += "(?:[^/]+/)*"
                index += 3
            elif pattern.startswith("**", index):
                regex += ".*"
                index += 2
            else:
                regex += "[^/]*"
                index += 1
        elif char == "?":
            regex += "[^/]"
            index += 1
        elif char == "[":
            close = pattern.find("]", index + 1)
            if close > 0:
                regex += pattern[index:close + 1]
                index = close + 1
            else:
                regex += r"\["
                index += 1
        else:
            regex += re.escape(char)
            index += 1
    return re.fullmatch(regex, relative) is not None


def spec(name, description, properties, required=()):
    return {"name": name, "description": description, "input_schema": {
        "type": "object", "properties": properties, "required": list(required), "additionalProperties": False}}


STRING = {"type": "string"}
POSITIVE = {"type": "integer", "minimum": 1}
DEFINITIONS = [
    spec("read_file", "读取 UTF-8 文件（含行号和 SHA256）；修改已有文件前必须读取。", {
        "path": STRING, "offset": POSITIVE, "limit": {**POSITIVE, "maximum": 2000}}, ["path"]),
    spec("list_files", "按 glob 列出项目文件（默认 **/*；** 递归、* 不跨目录，例如 src/**/*.py）；自动跳过构建产物和 .edacodeignore 指定项。", {"pattern": STRING}),
    spec("search", "递归搜索字面文本，返回路径和行号（不是正则表达式）；pattern 是限制范围的 glob。", {
        "text": {"type": "string", "minLength": 1}, "pattern": STRING, "case_sensitive": {"type": "boolean"}}, ["text"]),
    spec("write_file", "创建/覆盖 UTF-8 文件；已有文件必须先 read_file；提供 diff、检查读取后是否变化。", {
        "path": STRING, "content": STRING}, ["path", "content"]),
    spec("edit_file", "精确替换一段文本；默认只允许唯一匹配，多个匹配须明确 all=true。", {
        "path": STRING, "old_text": {"type": "string", "minLength": 1}, "new_text": STRING, "all": {"type": "boolean"}},
         ["path", "old_text", "new_text"]),
    spec("shell", "运行 Bash 命令，默认 120 秒；background=true 返回 job ID，须用 job_status 等待实际结果。", {
        "command": {"type": "string", "minLength": 1}, "timeout": {**POSITIVE, "maximum": 1800},
        "background": {"type": "boolean"}}, ["command"]),
    spec("job_status", "读取当前会话命令状态与输出，可等待最多 10 秒。", {
        "job_id": STRING, "wait": {"type": "integer", "minimum": 0, "maximum": 10}}, ["job_id"]),
    spec("cancel_job", "终止当前会话的命令进程组。", {"job_id": STRING}, ["job_id"]),
    spec("update_plan", "设置任务清单及状态；最多一个 in_progress；完成前更新实际进展。", {
        "items": {"type": "array", "maxItems": 20, "items": {"type": "object", "properties": {
            "step": {"type": "string", "minLength": 1}, "status": {"type": "string", "enum": ["pending", "in_progress", "completed"]}},
            "required": ["step", "status"], "additionalProperties": False}}}, ["items"]),
    spec("load_skill", "按目录名称读取一份完整 SKILL.md。", {"name": STRING}, ["name"]),
    spec("read_artifact", "分页读取当前会话归档的工具输出或压缩前记录，offset/limit 是字符数。", {
        "artifact_id": STRING, "offset": {"type": "integer", "minimum": 0}, "limit": {**POSITIVE, "maximum": 20000}}, ["artifact_id"]),
    spec("delegate", "启动独立上下文的只读调查子 agent；可并行多个问题，不能写文件、运行 shell 或再委派。", {
        "tasks": {"type": "array", "minItems": 1, "maxItems": 3, "items": {"type": "string", "minLength": 1}}}, ["tasks"]),
]


def validate(value, schema, label="args"):
    kind = schema.get("type")
    types = {"object": dict, "array": list, "string": str, "integer": int, "boolean": bool, "number": (int, float)}
    if kind in types and (not isinstance(value, types[kind]) or kind in {"integer", "number"} and isinstance(value, bool)):
        raise ValueError(f"{label} 必须为 {kind}")
    if "enum" in schema and value not in schema["enum"]:
        raise ValueError(f"{label} 不在允许值中")
    if isinstance(value, dict):
        properties = schema.get("properties", {})
        if set(schema.get("required", [])) - value.keys():
            raise ValueError(f"{label} 缺少必填参数")
        if schema.get("additionalProperties") is False and value.keys() - properties.keys():
            raise ValueError(f"{label} 含未知参数：{value.keys() - properties.keys()}")
        for key, item in value.items():
            if key in properties:
                validate(item, properties[key], f"{label}.{key}")
    if isinstance(value, list):
        if not schema.get("minItems", 0) <= len(value) <= schema.get("maxItems", 1000000):
            raise ValueError(f"{label} 数量越界")
        for item in value:
            validate(item, schema.get("items", {}), label + "[]")
    if isinstance(value, str) and len(value) < schema.get("minLength", 0):
        raise ValueError(f"{label} 不能为空")
    if type(value) in (int, float) and not schema.get("minimum", float("-inf")) <= value <= schema.get("maximum", float("inf")):
        raise ValueError(f"{label} 数值越界")


class Tools:
    def __init__(self, config, store, policy, display=lambda *args: None, readonly=False):
        self.config, self.store, self.policy, self.display = config, store, policy, display
        self.root = config.workspace
        self.protected = config.home.resolve()
        self.readonly = readonly
        self.seen = {}
        self.read_seen = {}
        self.processes = None if readonly else Processes(self.root)
        self.skills = self.discover_skills()
        self.commands = discover_commands(self.root, self.config.home)
        self.delegate_handler = None
        self.external = {}
        self.mcp = None
        self.definitions = {item["name"]: item for item in DEFINITIONS}
        if readonly:
            self.definitions = {n: self.definitions[n] for n in ("read_file", "list_files", "search", "load_skill", "read_artifact")}
        else:
            # 外部 MCP 工具只在主 agent 生效；定义并入工具表，但调用仍需 Policy 审批。
            self.mcp = MCPManager(self.root, display).load()
            for name, definition in self.mcp.definitions.items():
                self.definitions[name] = definition
                self.external[name] = (lambda arguments, _name=name: self.mcp.call(_name, arguments))

    def path(self, value):
        if not isinstance(value, str) or not value or "\x00" in value:
            raise ValueError("无效文件路径")
        path = (self.root / value).resolve()
        if (not path.is_relative_to(self.root) or path == self.protected or self.protected in path.parents
                or ".git" in path.relative_to(self.root).parts):
            raise PermissionError("路径必须位于工作区内，且不能访问 .git 内部")
        return path

    def discover_skills(self):
        skills = {}
        for root in (self.root / "skills", self.root / ".edacode" / "skills"):
            for path in sorted(root.glob("*/SKILL.md")):
                try:
                    path = self.path(str(path))
                    if path.stat().st_size > 100000:
                        continue
                    text = path.read_text(encoding="utf-8")
                    desc = next((line.split(":", 1)[1].strip().strip('\"\'') for line in text.splitlines()
                                 if line.startswith("description:")), "按需读取此技能")
                    skills[path.parent.name] = {"path": path, "description": desc[:240]}
                except (OSError, ValueError, UnicodeError):
                    continue
        return skills

    def specs(self):
        return list(self.definitions.values())

    def call(self, name, arguments):
        try:
            if name not in self.definitions:
                raise ValueError(f"未知或当前角色禁用的工具：{name}")
            if isinstance(arguments, str):
                arguments = json.loads(arguments)
            validate(arguments, self.definitions[name]["input_schema"])
            if name == "shell":
                check_command(arguments["command"])
            self.display("tool", name + " " + str({k: v for k, v in arguments.items() if k not in {"content", "old_text", "new_text"}})[:600])
            # 文件修改在生成 diff 后审批，用户能看到完整的具体变更。
            if name not in {"write_file", "edit_file"}:
                self.policy.authorize(name, encode(arguments))
            if name in self.external:
                output = self.external[name](arguments)
            else:
                output = getattr(self, name)(**arguments)
            text = output if isinstance(output, str) else encode(output)
            if len(text) > 16000:
                artifact = self.store.artifact(text)
                text = text[:12000] + f"\n[结果较长，完整输出使用 read_artifact：{artifact}]"
            failed = name in {"shell", "job_status"} and isinstance(output, dict) and output.get("status") in {"failed", "timeout", "cancelled"}
            return text, failed
        except (Exception,) as exc:
            return f"{type(exc).__name__}: {exc}", True

    def _bytes(self, path):
        if not path.is_file() or path.stat().st_size > 2_000_000:
            raise ValueError("只支持不超过 2 MB 的普通 UTF-8 文件")
        with path.open("rb") as handle:
            data = handle.read(2_000_001)
        if len(data) > 2_000_000:
            raise ValueError("读取过程中文件增长超过 2 MB")
        if b"\0" in data:
            raise ValueError("不支持二进制文件")
        data.decode("utf-8")
        return data

    def instructions(self, path):
        parts = []
        for parent in reversed([path.parent, *path.parent.parents]):
            if parent == self.root or not parent.is_relative_to(self.root):
                continue
            instruction = parent / "AGENTS.md"
            if instruction.is_file():
                try:
                    parts.append(f"\n[目录规范 {instruction.relative_to(self.root)}]\n" + self._bytes(self.path(str(instruction))).decode()[:12000])
                except (ValueError, OSError):
                    pass
        return "".join(parts)[:20000]

    def read_file(self, path, offset=1, limit=300):
        target = self.path(path)
        data = self._bytes(target)
        self.seen[str(target)] = digest(data)
        self.read_seen[str(target)] = True
        lines = data.decode().splitlines()
        rows = "\n".join(f"{i + 1:5} | {lines[i]}" for i in range(offset - 1, min(offset - 1 + limit, len(lines))))
        return f"{path} | sha256={digest(data)} | 共 {len(lines)} 行\n{rows}" + self.instructions(target)

    def files(self, pattern="**/*"):
        skipped = {".git", ".venv", "venv", "node_modules", "__pycache__", ".idea", ".edacode", "dist", "build", ".pytest_cache"}
        ignored = []
        ignore_file = self.root / ".edacodeignore"
        if ignore_file.is_file():
            try:
                ignored = [x.strip() for x in self._bytes(self.path(str(ignore_file))).decode().splitlines() if x.strip() and not x.lstrip().startswith("#")]
            except (OSError, ValueError, PermissionError):
                ignored = []
        total = 0
        for folder, dirs, names in os.walk(self.root, followlinks=False):
            dirs[:] = sorted(d for d in dirs if d not in skipped and not (Path(folder) / d).is_symlink()
                             and (Path(folder) / d).resolve() != self.protected
                             and self.protected not in (Path(folder) / d).resolve().parents)
            for name in sorted(names):
                # 统一用 POSIX 分隔符：fnmatch 的 pattern 用 /，Windows 的 Path 默认给 \，
                # 不统一会让 "src/**/*" 这类带目录的 pattern 和 @目录 前缀过滤全部失效。
                relative = (Path(folder) / name).relative_to(self.root).as_posix()
                if name == ".env" or name.startswith(".env.") and not name.endswith(("example", "sample")):
                    continue
                if any(fnmatch.fnmatch(relative, p) or relative.startswith(p.rstrip("/") + "/") for p in ignored):
                    continue
                if glob_match(relative, pattern):
                    try:
                        path = self.path(relative)
                        if not path.is_file():
                            continue
                    except (ValueError, OSError):
                        continue
                    yield relative
                    total += 1
                    if total >= 10000:
                        return

    def list_files(self, pattern="**/*"):
        from itertools import islice
        files = list(islice(self.files(pattern), 501))
        return "\n".join(files[:500]) + ("\n[至少还有一项，请缩小 pattern]" if len(files) > 500 else "") or "没有匹配文件"

    def search(self, text, pattern="**/*", case_sensitive=True):
        matches = []
        needle = text if case_sensitive else text.casefold()
        for relative in self.files(pattern):
            try:
                body = self._bytes(self.path(relative)).decode()
            except (ValueError, OSError):
                continue
            for i, line in enumerate(body.splitlines(), 1):
                if needle in (line if case_sensitive else line.casefold()):
                    matches.append(f"{relative}:{i}: {line[:500]}")
                    if len(matches) >= 200:
                        return "\n".join(matches) + "\n[已达 200 项，请缩小范围]"
        return "\n".join(matches) or "没有匹配内容"

    def _change(self, path, content, expected=None):
        if self.readonly:
            raise PermissionError("只读子 agent 不允许修改")
        target = self.path(path)
        if target == self.root:
            raise ValueError("不能替换工作目录")
        old = self._bytes(target) if target.exists() else None
        if expected is not None and old != expected:
            raise ValueError("计算替换内容期间文件发生变化，请重新读取")
        if old is not None and (self.seen.get(str(target)) != digest(old) or not self.read_seen.get(str(target))):
            raise ValueError("文件未读取或在读取后已变化；请重新 read_file 后编辑")
        new = content.encode("utf-8")
        if len(new) > 2_000_000:
            raise ValueError("单次写入不能超过 2 MB")
        if old == new:
            return "内容未变化"
        diff = "".join(difflib.unified_diff((old or b"").decode().splitlines(keepends=True), content.splitlines(keepends=True),
                                          fromfile=path if old is not None else "/dev/null", tofile=path))
        self.display("diff", diff)
        self.policy.authorize("write_file", diff)
        # 审批等待期间用户可能修改文件，再检查一次。
        target2 = self.path(path)
        if target2 != target or (self._bytes(target) if target.exists() else None) != old:
            raise ValueError("审批期间文件发生变化，已取消本次写入")
        mode = stat.S_IMODE(target.stat().st_mode) if old is not None else 0o644
        record = {"path": str(target.relative_to(self.root)), "before": base64.b64encode(old).decode() if old is not None else None,
                  "after": digest(new), "mode": mode, "undone": False, "status": "prepared", "diff": diff}
        self.store.data["changes"].append(record)
        self.store.save()
        try:
            atomic_write(target, new, mode)
        except BaseException:
            # prepared 保留中断证据；普通写入失败则跳过该条 undo 记录。
            if not target.is_file() or digest(self._bytes(target)) != record["after"]:
                record["status"] = "failed"
                self.store.save()
            raise
        record["status"] = "applied"
        self.store.save()
        self.seen[str(target)] = digest(new)
        self.read_seen[str(target)] = False
        return f"已修改 {path}，{len(new)} 字节\n{diff[:10000]}"

    def write_file(self, path, content):
        return self._change(path, content)

    def edit_file(self, path, old_text, new_text, all=False):
        original = self._bytes(self.path(path))
        text = original.decode()
        count = text.count(old_text)
        if count == 0 or count > 1 and not all:
            raise ValueError(f"原文匹配 {count} 处；请提供唯一原文，或明确 all=true")
        return self._change(path, text.replace(old_text, new_text) if all else text.replace(old_text, new_text, 1), expected=original)

    def undo(self):
        for change in reversed(self.store.data["changes"]):
            if change["undone"] or change["status"] == "failed":
                continue
            target = self.path(change["path"])
            if not target.is_file() or digest(target.read_bytes()) != change["after"]:
                raise ValueError("文件在此变更后发生变化，拒绝覆盖；请手动检查 /diff")
            if change["before"] is None:
                target.unlink()
            else:
                atomic_write(target, base64.b64decode(change["before"]), change["mode"])
            change["undone"] = True
            self.seen.pop(str(target), None)
            self.read_seen.pop(str(target), None)
            self.store.save()
            return "已撤销：" + change["path"]
        return "没有可撤销的专用工具文件修改"

    def shell(self, command, timeout=120, background=False):
        if background:
            job = self.processes.start(command, timeout)
            return {"job_id": job.id, "status": "running", "note": "必须用 job_status 检查完成结果；重启不恢复进程"}
        return self.processes.run(command, timeout)

    def job_status(self, job_id, wait=0):
        import time
        job = self.processes.get(job_id)
        deadline = time.monotonic() + wait
        while job.poll()["status"] == "running" and time.monotonic() < deadline:
            time.sleep(0.1)
        return job.poll()

    def cancel_job(self, job_id):
        return self.processes.get(job_id).stop()

    def update_plan(self, items):
        if sum(item["status"] == "in_progress" for item in items) > 1:
            raise ValueError("只能有一个进行中的步骤")
        self.store.data["todos"] = items
        self.store.save()
        return items

    def load_skill(self, name):
        if name not in self.skills:
            raise ValueError("未知技能：" + name)
        return self._bytes(self.path(str(self.skills[name]["path"]))).decode()

    def read_text(self, path, limit=100_000):
        """读取工作区内文本文件用于上下文注入；不登记 read-before-edit 状态。"""
        data = self._bytes(self.path(path)).decode()
        if len(data) > limit:
            return data[:limit] + f"\n[已截断，原文共 {len(data)} 字符]"
        return data

    def read_artifact(self, artifact_id, offset=0, limit=12000):
        return self.store.read_artifact(artifact_id, offset, limit)

    def delegate(self, tasks):
        if self.delegate_handler is None:
            raise ValueError("当前会话未启用子 agent")
        return self.delegate_handler(tasks)

    def close(self):
        if self.mcp:
            self.mcp.close()
        if self.processes:
            self.processes.close()
