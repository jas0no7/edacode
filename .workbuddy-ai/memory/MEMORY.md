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
- 项目内**没有 `.env`**（含密钥的那份在历史迁移中丢失），跑真模型需主人自己放回。

## 约定
- 交付要说清：改了哪些文件 / 接口或命令怎么用 / 怎么验证的。
- 不交半成品：测试必须真绿，不许用 skip 掩盖真实缺陷。
