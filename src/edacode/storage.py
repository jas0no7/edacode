"""原子快照 + 审计事件；恢复时不会自动重新执行未确认完成的副作用。"""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import time
import uuid

from .compat import lock_file, unlock_file


def encode(value):
    return json.dumps(value, ensure_ascii=False, indent=2)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def atomic_write(path: Path, data: bytes, mode: int = 0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".edacode-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(name, mode)
        # Windows 上 os.replace 不能覆盖只读目标，先清掉只读属性。
        if os.name == "nt" and path.exists() and not os.access(path, os.W_OK):
            os.chmod(path, stat.S_IWRITE | stat.S_IREAD)
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def project_root(config):
    return config.home / "projects" / digest(str(config.workspace).encode())[:20]


def list_sessions(config):
    root = project_root(config) / "sessions"
    rows = []
    for path in root.glob("*/session.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if data.get("kind") == "subagent":
                continue
            rows.append({"id": data["id"], "updated": data["updated"], "title": data.get("title", "")})
        except (ValueError, KeyError, OSError):
            continue
    return sorted(rows, key=lambda x: x["updated"], reverse=True)


class Store:
    def __init__(self, config, resume=None):
        self.config = config
        self.project = project_root(config)
        if resume == "latest":
            sessions = list_sessions(config)
            if not sessions:
                raise ValueError("当前工作区没有可以恢复的会话")
            resume = sessions[0]["id"]
        self.id = resume or time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:8]
        if not re.fullmatch(r"[0-9]{8}-[0-9]{6}-[a-f0-9]{8}", self.id):
            raise ValueError("无效 session ID")
        self.root = self.project / "sessions" / self.id
        self.path = self.root / "session.json"
        if resume and not self.path.is_file():
            raise ValueError(f"会话不存在：{self.id}")
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._lock = (self.root / ".lock").open("a")
        try:
            lock_file(self._lock, blocking=False)
        except BlockingIOError as exc:
            self._lock.close()
            self._lock = None
            raise ValueError("会话已在另一进程打开") from exc
        except Exception as exc:
            self._lock.close()
            self._lock = None
            raise ValueError("无法为会话加锁：" + str(exc)) from exc
        try:
            if resume:
                self.data = json.loads(self.path.read_text(encoding="utf-8"))
                if self.data.get("version") != 1 or self.data.get("workspace") != str(config.workspace):
                    raise ValueError("会话版本或工作区不匹配")
                self.repair_pending()
            else:
                self.data = {"version": 1, "id": self.id, "workspace": str(config.workspace),
                             "title": "", "messages": [], "todos": [], "goal": None,
                             "usage": {"input": 0, "output": 0}, "changes": [], "updated": time.time()}
            self.save()
        except BaseException:
            self.close()
            raise

    def save(self):
        self.data["updated"] = time.time()
        atomic_write(self.path, encode(self.data).encode())

    def event(self, kind, **data):
        with (self.root / "events.jsonl").open("a", encoding="utf-8") as handle:
            os.chmod(handle.name, 0o600)
            handle.write(json.dumps({"time": time.time(), "type": kind, **data}, ensure_ascii=False) + "\n")
            handle.flush()
            os.fsync(handle.fileno())

    def repair_pending(self):
        messages = self.data["messages"]
        # snapshot 只可能在 assistant 后或部分 tool results 后中断。
        last = next((i for i in range(len(messages) - 1, -1, -1) if messages[i]["role"] == "assistant"), None)
        if last is None:
            return
        done = {m["tool_call_id"] for m in messages[last + 1:] if m["role"] == "tool"}
        for call in messages[last].get("tool_calls", []):
            if call["id"] not in done:
                messages.append({"role": "tool", "tool_call_id": call["id"], "is_error": True,
                                 "content": "运行被中断，执行状态未知；禁止盲目重放，请先检查实际文件/进程状态。"})

    def artifact(self, content: str, prefix="output"):
        name = f"{prefix}-{uuid.uuid4().hex}.txt"
        atomic_write(self.root / "artifacts" / name, content.encode())
        return name

    def read_artifact(self, artifact_id, offset=0, limit=12000):
        if not re.fullmatch(r"[a-z]+-[a-f0-9]{32}\.txt", artifact_id):
            raise ValueError("无效 artifact ID")
        data = (self.root / "artifacts" / artifact_id).read_text(encoding="utf-8")
        return data[offset:offset + limit] + f"\n[字符 {offset}:{min(offset + limit, len(data))} / {len(data)}]"

    def close(self):
        if getattr(self, "_lock", None):
            unlock_file(self._lock)
            self._lock.close()
            self._lock = None
