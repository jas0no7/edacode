# edacode 项目长期记忆

## 项目定位
- `D:\project_all\jason\edacode` 是一个**独立的交互式 coding agent**（Python）。
- 来源：主人学习 agent 时写的 `01.py`–`17.py`，加上对开源 agent
  （openai/codex、anomalyco/opencode、google-gemini/gemini-cli、QwenLM/qwen-code、
  zai-org/ZCode）的架构调研后重构而成。不 import 那些课程脚本。
- 目录名/包名/命令名/配置前缀统一为 `edacode` / `edacode` / `edacode` / `EDACODE_*`。
  （历史上曾叫 `closecode`，主人最终决定保留 `edacode`。）

## 架构边界（改代码时不要破坏）
- `providers.py` provider 适配（Anthropic / OpenAI 兼容 / mock）；`engine.py` 宿主循环；
  `tools.py` 工具表；`permissions.py` 策略；`storage.py` 快照/事件/锁；`processes.py` 进程。
- **平台差异一律放 `compat.py`**，其他模块不得直接 import `fcntl` / 用 `os.killpg` / 硬编码 `/bin/bash`。
- 上下文压缩（`context.py`）必须按**完整 assistant+tool 事务单元**压缩，不能按消息条数截断。
- 外部工具（MCP）定义 ≠ 授权，必须走 Policy 审批。

## 环境与命令
- 开发机：Windows + Git Bash；Python 用托管 venv
  `C:\Users\edac\.workbuddy-ai\binaries\python\envs\default\Scripts\python.exe`
  （托管 Python 本体没装 anthropic/openai，mock 路径够用；真模型需装 `.[anthropic]`）。
- 测试：`cd edacode && PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python -m unittest discover -s tests -v`
- 冒烟：`python run.py --provider mock --workspace . --json -p "列出当前文件"`
- 主人已把 `.env` 放回项目根（`ANTHROPIC_BASE_URL=https://4sapi.org` / `ANTHROPIC_API_KEY` /
  `MODEL_ID=claude-opus-4-6`），且已被 `.gitignore` 忽略（安全）。**不要在回复里回显 key**。
- 主机的 uv 在 `C:\Users\edac\.local\bin\uv.exe`；该目录是主人的用户级 CLI 目录（`claude.exe`、
  `uv`、`jadx-mcp-server` 都在这），且**已在持久 PATH 上**。

## 全局命令安装（2026-10-08 完成）
- `edacode` 已用 **`uv tool install --editable D:\project_all\jason\edacode`** 装成全局命令，
  shim 在 `C:\Users\edac\.local\bin\edacode.exe`，工具环境在 `%APPDATA%\uv\tools\edacode`。
  → 改源码即时生效（editable）；重装用 `uv tool install --editable --force`，
  卸载用 `uv tool uninstall edacode`。
- **配置查找顺序**：`<当前目录>/.env` → `~/.edacode/.env`（用户级兜底，已写入真实 key）。
  实现见 `config.py:load_config`（先工作区后 home，`load_dotenv(override=False)` 让工作区优先）。
- `--workspace` 默认 `.`，所以**在哪个目录敲 `edacode`，那个目录就是工作区**。
- 注意：WorkBuddy 沙箱里的 PowerShell 工具**捕获不到原生命令 stdout**（`python --version` 也是空的），
  验证 CLI 请用 Bash 工具；沙箱 PATH 首位的 `safe-bin` 垫片会让裸命令名解析异常，属沙箱现象。


## 约定
- 交付要说清：改了哪些文件 / 接口或命令怎么用 / 怎么验证的。
- 不交半成品：测试必须真绿，不许用 skip 掩盖真实缺陷。
