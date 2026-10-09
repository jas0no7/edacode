"""跨平台差异集中在这里：文件锁、shell 可执行文件、进程树终止。

EdaCode 最初在 macOS/Linux 上开发，直接使用 fcntl.flock、os.killpg 和 /bin/bash。
这些在 Windows 上都不存在，因此把平台分支收敛到本模块，其余代码只调用这里的函数。
"""
import os
import signal
import subprocess

IS_WINDOWS = os.name == "nt"


def lock_file(handle, blocking=False):
    """对已打开的句柄加排他锁。非阻塞模式抢不到锁时抛 BlockingIOError。"""
    if IS_WINDOWS:
        import msvcrt
        handle.seek(0)
        try:
            msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK if blocking else msvcrt.LK_NBLCK, 1)
        except OSError as exc:
            raise BlockingIOError(str(exc)) from exc
    else:
        import fcntl
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))


def unlock_file(handle):
    """释放 lock_file 加的锁；失败不抛，句柄关闭时系统也会释放。"""
    try:
        if IS_WINDOWS:
            import msvcrt
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    except OSError:
        pass


def find_shell():
    """返回执行 shell 命令用的 bash 路径；非 Windows 固定 /bin/bash，Windows 找不到返回 None。"""
    if not IS_WINDOWS:
        return "/bin/bash"
    import shutil
    candidates = (
        os.environ.get("EDACODE_SHELL"),
        shutil.which("bash"),
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files (x86)\Git\bin\bash.exe",
        r"E:\Git\bin\bash.exe",
    )
    for candidate in candidates:
        if candidate and os.path.isfile(candidate):
            return candidate
    return None


def shell_argv(command):
    """构造执行一条 shell 命令的 (args, kwargs)。

    Windows 的 shell=True 会拼成 ``cmd.exe /c`` 语义，把 bash 当 executable 会得到
    ``bash /c ...``（bash 不认）。所以找到 bash 时显式用 ``bash -c``，找不到才回退系统 shell。
    """
    shell = find_shell()
    if shell:
        return [shell, "-c", command], {"start_new_session": not IS_WINDOWS}
    return command, {"shell": True, "start_new_session": not IS_WINDOWS}


def kill_tree(process):
    """终止进程及其全部子进程；尽力而为，进程已退出或权限不足都不抛异常。"""
    # POSIX 组长退出不意味着子进程已经退出；仍要回收同组后代。
    if IS_WINDOWS and process.poll() is not None:
        return
    try:
        if IS_WINDOWS:
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(process.pid)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        else:
            os.killpg(process.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        pass
