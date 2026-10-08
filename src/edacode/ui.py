"""终端外观：opencode 风格的欢迎屏、状态栏与输入提示。

只依赖标准库和 ANSI 转义序列，不引入 TUI 框架 —— 这样在 cmd / PowerShell /
Windows Terminal / Git Bash(mintty) / macOS / Linux 上都稳定，不需要 winpty。
非 tty、设置了 NO_COLOR，或 stdout 被重定向时自动降级为纯文本，方便管道与日志。
"""
from __future__ import annotations

import os
import re
import shutil
import sys
import unicodedata

from . import __version__

_ANSI = re.compile(r"\x1b\[[0-9;]*m")

TIPS = (
    "输入 @路径 可以注入文件内容或目录清单",
    "/mode 切换 plan / ask / edit / auto 权限",
    "/checkpoint 打检查点，/restore 回滚文件与对话",
    "行尾加反斜杠可以输入多行",
    "/goal <完成条件> 让 agent 自己验证到完成为止",
)

MODE_LABELS = {"plan": "Plan", "ask": "Ask", "edit": "Edit", "auto": "Auto"}
MODE_COLORS = {"plan": 96, "ask": 93, "edit": 94, "auto": 92}

# 5 行高、5 列宽的方块像素字。只收录 "edacode" 用到的字母。
# 每个字母都留出字腔（空洞），否则相邻字母的实心行会连成一条横杠。
_FONT = {
    "a": ("█████", "    █", "█████", "█   █", "█████"),
    "c": ("█████", "█    ", "█    ", "█    ", "█████"),
    "d": ("    █", "█████", "█   █", "█   █", "█████"),
    "e": ("█████", "█   █", "█████", "█    ", "█████"),
    "o": ("█████", "█   █", "█   █", "█   █", "█████"),
    " ": ("     ", "     ", "     ", "     ", "     "),
}


class Palette:
    """ANSI 调色板。enabled=False 时所有颜色码都是空串，输出即纯文本。

    正文用 16 色 ANSI（终端会按自身主题重映射，浅色/深色终端都不瞎），
    只有装饰性的 logo 渐变用 256 色灰度，针对深色终端调优。
    """

    def __init__(self, enabled=True):
        self.enabled = bool(enabled)
        self.reset = self._s("0")
        self.bold = self._s("1")
        self.dim = self._s("2")
        self.accent = self._s("94")
        self.text = ""
        self.muted = self._s("90")
        self.faint = self._s("2;90")
        self.green = self._s("92")
        self.yellow = self._s("93")
        self.red = self._s("91")

    def _s(self, spec):
        return f"\x1b[{spec}m" if self.enabled else ""

    def fg(self, level):
        return self._s(f"38;5;{level}")

    def mode(self, name):
        return self._s(str(MODE_COLORS.get(name, 97)))

    def gradient(self, row, rows):
        """logo 的竖向渐变：上暗下亮（深色终端观感最佳）。"""
        if not self.enabled:
            return ""
        low, high = 240, 255
        level = low + round((high - low) * row / max(rows - 1, 1))
        return self.fg(level)


PLAIN = Palette(False)


def supports_color(stream=None):
    stream = stream or sys.stdout
    if os.environ.get("NO_COLOR"):
        return False
    if os.environ.get("FORCE_COLOR"):
        return True
    try:
        return bool(stream.isatty())
    except Exception:
        return False


def enable_windows_ansi():
    """Windows 10+ 需要显式打开虚拟终端序列，否则 ANSI 会原样打印。"""
    if os.name != "nt":
        return
    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32
        for handle in (-11, -12):  # STD_OUTPUT_HANDLE / STD_ERROR_HANDLE
            std = kernel32.GetStdHandle(handle)
            mode = ctypes.c_uint32()
            if kernel32.GetConsoleMode(std, ctypes.byref(mode)):
                kernel32.SetConsoleMode(std, mode.value | 0x0004)
    except Exception:
        pass


def strip(text):
    return _ANSI.sub("", text)


def visible_width(text):
    """按终端列宽计算长度：CJK 全角算 2 列，ANSI 转义不计入。"""
    total = 0
    for char in _ANSI.sub("", text):
        total += 2 if unicodedata.east_asian_width(char) in "WF" else 1
    return total


def terminal_width(default=88):
    try:
        return max(shutil.get_terminal_size((default, 24)).columns, 40)
    except Exception:
        return default


def logo(text="edacode"):
    """把文本渲染成方块像素字，返回 5 行字符串。"""
    rows = [""] * 5
    for char in text:
        glyph = _FONT.get(char.lower(), _FONT[" "])
        for index in range(5):
            rows[index] += glyph[index] + "  "
    return [row[:-2] for row in rows]


def shorten_home(path):
    home = os.path.expanduser("~")
    path = str(path)
    if home and path.startswith(home):
        return "~" + path[len(home):]
    return path


def mode_label(mode):
    return MODE_LABELS.get(mode, mode.capitalize())


def _right_aligned(left, width, text):
    return " " * (left + max(width - visible_width(text), 0)) + text


def status_bar(config, tools, palette, width=None):
    """底部状态栏：左「工作区 ● MCP /status」，右版本号。"""
    width = width or terminal_width()
    mcp = getattr(tools, "mcp", None)
    count = len(mcp.servers) if mcp else 0
    dot = (palette.green if count else palette.faint) + "●" + palette.reset
    left = (f" {palette.muted}{shorten_home(config.workspace)}{palette.reset}"
            f"  {dot} {palette.faint}{count} MCP{palette.reset}"
            f"  {palette.faint}/status{palette.reset}")
    right = f"{palette.faint}{__version__}{palette.reset} "
    gap = max(width - visible_width(left) - visible_width(right), 1)
    return left + " " * gap + right


def welcome(config, tools, palette, width=None, tip=None):
    """opencode 风格欢迎屏：logo + 输入框 + 快捷键提示 + Tip + 状态栏。"""
    width = width or terminal_width()
    out = [""]

    art = logo("edacode")
    pad = max((width - visible_width(art[0])) // 2, 2)
    for index, row in enumerate(art):
        out.append(" " * pad + palette.gradient(index, len(art)) + row + palette.reset)
    out.append("")

    content = min(max(width - 6, 40), 76)
    left = max((width - content - 4) // 2, 2)
    bar = palette.accent + "┃" + palette.reset

    placeholder = '随便说点什么…  "修复 src 里的 TODO"'
    out.append(" " * left + bar + "  " + palette.muted + placeholder + palette.reset)

    mode = getattr(config, "mode", "edit")
    model = getattr(config, "model", "") or "mock"
    provider = getattr(config, "provider", "")
    out.append(" " * left + bar + "  "
               + palette.mode(mode) + mode_label(mode) + palette.reset
               + "  " + palette.text + model + palette.reset
               + "  " + palette.faint + provider + palette.reset)
    out.append("")

    hints = (palette.faint + "/help 命令" + palette.reset
             + palette.faint + "    /mode 切换权限" + palette.reset
             + palette.faint + "    Ctrl-C 退出" + palette.reset)
    out.append(_right_aligned(left, content, hints))
    out.append("")

    tip_text = tip or TIPS[0]
    out.append(" " * left + palette.yellow + "●" + palette.reset
               + " " + palette.bold + "Tip" + palette.reset
               + " " + palette.muted + tip_text + palette.reset)
    out.append("")
    out.append(status_bar(config, tools, palette, width))
    out.append("")
    return "\n".join(out)


def prompt_text(palette, mode="edit"):
    return f"\n{palette.mode(mode)}{palette.bold}❯{palette.reset} "
