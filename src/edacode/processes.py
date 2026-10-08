"""前后台命令统一管理进程组、超时、输出限额和退出清理。"""
import os
import subprocess
import threading
import time
import uuid

from .compat import kill_tree, shell_argv


class Job:
    def __init__(self, command, cwd, timeout):
        self.id = "job_" + uuid.uuid4().hex[:12]
        self.command, self.timeout = command, timeout
        self.started = time.monotonic()
        self.buffer = bytearray()
        self.truncated = False
        self.status = "running"
        self.lock = threading.Lock()
        self.state_lock = threading.RLock()
        self._group_cleaned = False
        args, kwargs = shell_argv(command)
        self.process = subprocess.Popen(args, cwd=cwd, stdin=subprocess.DEVNULL,
                                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, **kwargs)
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self):
        try:
            while True:
                # BufferedReader.read(size) 可能等满 size 才返回；os.read 保留增量输出。
                chunk = os.read(self.process.stdout.fileno(), 4096)
                if not chunk:
                    break
                with self.lock:
                    remaining = 2_000_000 - len(self.buffer)
                    self.buffer.extend(chunk[:max(0, remaining)])
                    self.truncated |= len(chunk) > remaining
        finally:
            self.process.stdout.close()

    def kill_group(self):
        # 每个 Job 只清理一次，避免 close/poll 再次向已经复用的 PID 发信号。
        if self._group_cleaned:
            return
        self._group_cleaned = True
        kill_tree(self.process)

    def _refresh(self):
        """调用方持有 state_lock；监控线程与前台等待共享同一终态转换。"""
        if self.status == "running":
            code = self.process.poll()
            if code is not None:
                self.status = "completed" if code == 0 else "failed"
                self.kill_group()
            elif time.monotonic() - self.started >= self.timeout:
                self.status = "timeout"
                self.kill_group()
                self.process.wait()
            if self.status != "running":
                self.reader.join(timeout=1)

    def poll(self):
        with self.state_lock:
            self._refresh()
            status, code = self.status, self.process.returncode
        with self.lock:
            output = self.buffer.decode("utf-8", errors="replace")
        if self.truncated:
            output += "\n[输出超过 2 MB，后续内容丢弃；请缩小命令输出范围]"
        return {"job_id": self.id, "status": status, "exit_code": code,
                "command": self.command, "output": output}

    def stop(self):
        with self.state_lock:
            self._refresh()
            if self.status == "running":
                self.status = "cancelled"
                self.kill_group()
                self.process.wait()
                self.reader.join(timeout=1)
        return self.poll()


class Processes:
    def __init__(self, cwd):
        self.cwd, self.jobs = cwd, {}
        self.lock = threading.RLock()
        self.closed = threading.Event()
        self.monitor = threading.Thread(target=self._watch, daemon=True)
        self.monitor.start()

    def _watch(self):
        while not self.closed.wait(0.2):
            with self.lock:
                jobs = list(self.jobs.values())
            for job in jobs:
                with job.state_lock:
                    job._refresh()

    def start(self, command, timeout=120):
        if not isinstance(command, str) or not command.strip():
            raise ValueError("command 必须是非空字符串")
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not 0 < timeout <= 1800:
            raise ValueError("timeout 必须在 0 到 1800 秒之间")
        with self.lock:
            if self.closed.is_set():
                raise ValueError("命令管理器已关闭")
            if sum(j.status == "running" for j in self.jobs.values()) >= 4:
                raise ValueError("最多同时运行 4 个命令")
            job = Job(command, self.cwd, timeout)
            self.jobs[job.id] = job
            return job

    def run(self, command, timeout=120):
        job = self.start(command, timeout)
        try:
            while job.poll()["status"] == "running":
                time.sleep(0.1)
            return job.poll()
        except BaseException:
            job.stop()
            raise

    def get(self, job_id):
        with self.lock:
            if job_id not in self.jobs:
                raise ValueError("未知 job ID；进程不会在重启后恢复")
            return self.jobs[job_id]

    def close(self):
        with self.lock:
            self.closed.set()
            jobs = list(self.jobs.values())
        self.monitor.join(timeout=1)
        for job in jobs:
            job.stop()
