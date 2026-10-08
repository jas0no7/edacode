"""审批策略不是操作系统沙箱。任意 shell 均可访问当前用户的权限范围。"""
import re

READ_TOOLS = {"read_file", "list_files", "search", "load_skill", "read_artifact", "job_status", "update_plan", "delegate"}
WRITE_TOOLS = {"write_file", "edit_file"}


def check_command(command):
    """仅快速拦截，不是 shell 解析器；安全边界仍然是审批和外部沙箱。"""
    text = re.sub(r"\s+", " ", command.casefold()).strip()
    if any(item in text for item in ("rm -rf /", "sudo ", "shutdown", "reboot", "mkfs", "dd if=", ":(){ :|:& };:")):
        raise PermissionError("命令命中 EdaCode 硬拒绝规则，未执行")


class Policy:
    def __init__(self, mode="edit", confirm=None):
        if mode not in {"plan", "ask", "edit", "auto"}:
            raise ValueError("无效权限模式")
        self.mode = mode
        self.confirm = confirm or (lambda name, detail: False)

    def authorize(self, name, detail=""):
        if name in READ_TOOLS:
            return
        if self.mode == "plan":
            raise PermissionError(f"plan 模式禁止 {name}；请由用户通过 /mode 切换")
        if self.mode == "auto" or (self.mode == "edit" and name in WRITE_TOOLS):
            return
        # 包括所有 shell 和外部 MCP 调用：不从命令文本猜测其无副作用。
        if not self.confirm(name, detail):
            raise PermissionError(f"用户未批准 {name}；请调整方案，不要重复相同调用")
