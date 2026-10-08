# EdaCode

EdaCode 是一个独立、可检查的交互式 coding agent。它的设计来源有两处：一是作者学习 agent 时写的 `01.py`–`17.py` 系列脚本（这些脚本已不在本仓库中，只保留了下面的经验映射表），二是对 Codex、OpenCode、Gemini CLI、Qwen Code、ZCode 等开源 agent 的架构调研。EdaCode 不导入任何课程脚本，可以独立升级。

## 运行

在项目目录（`edacode/`）下执行：

```bash
# 不需要 API key，先用确定性的离线工具调用检查安装
python run.py --provider mock --workspace .

# 使用现有 .env（ANTHROPIC_API_KEY、MODEL_ID，可选 ANTHROPIC_BASE_URL）
python run.py --workspace .

# 安装为 edacode 命令
python -m pip install -e .
edacode --workspace .
```

Windows 与 macOS/Linux 都支持：文件锁在 Windows 用 `msvcrt.locking`、在 POSIX 用 `fcntl.flock`；shell 工具优先探测 `bash`（Git for Windows / MSYS2），找不到才回退系统 shell；进程终止在 Windows 用 `taskkill /T`、在 POSIX 用 `killpg`。这些平台分支集中在 `src/edacode/compat.py`，可用 `EDACODE_SHELL` 指定 bash 路径。

`edacode/.env.example` 是配置模板。也支持 OpenAI Chat Completions 兼容接口：安装 `pip install -e '.[openai]'`，设置 `EDACODE_PROVIDER=openai`、`OPENAI_API_KEY` 和 `EDACODE_MODEL`。

会话状态默认保存在 `~/.edacode/projects/<workspace-hash>/sessions/`，可以用 `--resume` 或 `--resume latest` 继续。状态目录不写进项目，避免把密钥、对话和运行日志误提交。

## 交互方式

输入自然语言即可让模型检查、修改和验证项目。常用命令：

```text
/help
/mode plan|ask|edit|auto
/goal pytest -q 退出码必须为 0
/status
/diff
/undo
/memory add 项目使用 Python 3.10
/sessions
/mcp
/commands list|reload
/compact
/quit
```

四种模式对应不同的执行边界：`plan` 只读，`ask` 每个写入和命令都询问，`edit` 自动写文件但命令询问，`auto` 自动执行。危险 shell 模式（例如 `sudo`、`rm -rf /`、`mkfs`、关机和设备重定向）始终硬拒绝。

## 自定义命令与上下文引用

把常用的长 prompt 固化成 Markdown 文件即可当斜杠命令用（借鉴 Gemini CLI 的 custom commands 与 Qwen Code / Claude Code 的 Markdown 命令）：

```text
<workspace>/.edacode/commands/   项目命令（优先级高，可入库共享）
<home>/commands/                 用户命令（跨项目可用）
```

- 子目录用 `:` 命名空间：`git/commit.md` → `/git:commit`。
- 参数：`$ARGUMENTS` / `{{args}}` 注入全部参数，`$1`..`$9` 注入位置参数；正文没有占位符时参数追加到末尾。
- `@{path}` 注入文件内容或目录清单；`!{cmd}` 注入命令输出。
- **`!{cmd}` 走完整权限策略**：plan 模式拒绝，ask/edit 模式逐次审批，auto 模式才直接执行。
- 普通输入里的 `@路径` 也会注入内容；只有能解析到工作区内真实路径的 token 才会替换，`a@b.com` 这类文本不受影响。

`review.md` 示例：

```markdown
---
description: 审查指定文件
argument-hint: <path>
---
请审查 $1，重点看边界条件和错误处理。
参考规范：
@{docs/best-practices.md}
```

展开顺序是 参数替换 → 文件注入 → shell 注入：参数因此可以用在 `!{...}` 里，而被注入的文件正文不会被二次替换。

## 外部 MCP 工具

在项目根目录或 `.edacode/mcp.json` 放一份配置，EdaCode 会在启动时用 stdio 启动这些 server 并合并其工具：

```json
{"mcpServers": {"filesystem": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]}}}
```

- 工具名统一为 `mcp__<server>__<tool>`，出现在 `/tools` 里，`/mcp` 查看 server 状态。
- 握手使用 JSON-RPC over stdio（`initialize` → `notifications/initialized` → `tools/list` → `tools/call`），协议版本 `2024-11-05`。
- 外部工具定义**不等于**授权：`plan` 模式拒绝，`ask`/`edit` 模式逐次审批，`auto` 才自动执行。
- 单个 server 启动失败只记录到 `/mcp`，不影响内置工具和其他 server。

## 已实现的核心

- Anthropic Messages API 和 OpenAI 兼容接口的 provider 适配；网络/限流错误只在没有输出或工具执行前重试。
- 结构化工具循环：每个 `tool_use` 都对应一个 `tool_result`，工具异常会回传给模型，不会让整个会话崩溃。
- 工作区边界：文件工具解析真实路径、拒绝软链接越界和 `.git`，跳过 `.env`、构建目录和 `.edacode`。
- 文件编辑的读取前置、SHA-256 变更检测、唯一匹配、统一 diff、审批后再次冲突检查、原子写入和 `/undo`。
- 前后台 shell 进程组、超时、2 MB 输出限额、最多四个并发作业、Ctrl-C 清理；重启不会假装恢复后台进程。
- 项目级 `AGENTS.md`、`GEMINI.md`、`EDACODE.md` 指令和 `skills/*/SKILL.md` 按需加载。
- `update_plan` 计划、跨会话用户记忆、长结果归档、上下文压缩、会话文件锁和中断后的未完成工具调用标记。
- `delegate` 只读调查子 agent，以及独立 Goal 判断器；Goal 未完成时自动继续，达到 `max_turns` 后把控制权交还用户。
- 外部 MCP（stdio）工具接入：`mcp.json` 配置、握手、工具发现与调用，命名空间隔离且默认需要审批。
- 自定义斜杠命令（Markdown，项目/用户两级）与 `@文件` / `!{命令}` 上下文注入；shell 注入复用同一套审批。
- glob 语义正确：`**` 递归、`*` 不跨目录，`src/**/*.py` 这类 pattern 在 Windows 上也匹配。
- 跨平台：文件锁、shell 探测、进程树终止在 Windows 与 POSIX 上都可用，平台分支集中在 `compat.py`。
- `--provider mock` 离线冒烟路径，方便在没有模型和密钥时验证文件、会话和工具边界。

这不是操作系统级沙箱。Bash 仍以当前用户身份运行在工作区目录；`auto` 只适合你信任的项目。需要更强隔离时应在容器、虚拟机或 Codex/Gemini 等自带 sandbox 中运行。

## 从 01.py–17.py 提炼的结构

这些课程脚本已不在仓库中；下表保留它们与 EdaCode 模块的对应关系，方便回溯设计来源。

| 学习脚本 | 主要经验 | EdaCode 的落点 |
| --- | --- | --- |
| 01–02 | 最小 tool loop、专用读写工具、工作区路径 | `providers.py`、`tools.py` |
| 03–04 | 硬拒绝、审批闸门和 hooks | `permissions.py`、`engine.py` |
| 05–07 | Todo、子 agent、Skill 目录按需加载 | `update_plan`、`delegate`、`load_skill` |
| 08–09 | 工具结果归档、消息压缩、跨会话 memory | `Store`、`Memory`、`Engine._context` |
| 10 | 持久任务图和原子 JSON | 保留为下一阶段扩展点；当前计划先用 `update_plan` |
| 11–12 | 后台进程组、超时和调度 | `processes.py`；Cron 暂不伪装成已实现 |
| 13–15 | worktree、团队协议、MCP、统一 harness | `mcp.py` 已接入 stdio MCP（命名空间 + 审批）；worktree/团队与统一 harness 仍待下一版 |
| 16 | 固定 workflow、schema 校验、journal resume | 会话 snapshot、事件日志和结构化 provider |
| 17 | 主模型提出停止，独立判断器检查 Goal | `GoalEvaluator` 和 `/goal` |

## 参考的开源 agent 设计

- [OpenAI Codex CLI](https://github.com/openai/codex)：本地终端 agent、`AGENTS.md` 项目指令和 suggest/auto-edit/full-auto 这种权限分层启发了 EdaCode 的模式设计。
- [OpenCode](https://github.com/anomalyco/opencode)：内置 build/plan 主 agent 与 general 子 agent 的职责分离启发了只读 `plan` 和 `delegate`。
- [Gemini CLI](https://github.com/google-gemini/gemini-cli)：**custom commands（TOML/Markdown + `{{args}}` / `!{shell}` / `@{file}` / `:` 命名空间）**、`@` 文件引用、checkpoint/restore、context 文件、MCP 和 headless JSON 入口。
- [Qwen Code](https://github.com/QwenLM/qwen-code)：独立上下文 subagent、项目级 Markdown 命令与 skill、多协议 provider 分层、headless 与 session 管理。
- [ZCode](https://github.com/zai-org/ZCode) 与 [Softorize/zcode](https://github.com/Softorize/zcode)：结构化 `assistant + tool_calls + control`、policy/audit、mock provider、验证后再结束和 CI/headless 入口。

EdaCode 采纳的是可解释的机制，而不是照搬实现：

| 机制 | 来源 | EdaCode 落点 |
| --- | --- | --- |
| 项目指令文件分层 | Codex / Gemini / Qwen | `AGENTS.md`、`GEMINI.md`、`EDACODE.md` |
| 权限分层（只读/审批/自动） | Codex / OpenCode | `plan/ask/edit/auto` + 硬拒绝 |
| 只读调查子 agent | OpenCode / Qwen | `delegate`（独立 Store、只读工具集） |
| 自定义命令 + 上下文注入 | Gemini CLI / Qwen Code | `commands.py`（`$ARGUMENTS`、`@{path}`、`!{cmd}`、`:` 命名空间） |
| `@` 文件引用 | Gemini CLI | `commands.inject_references` |
| MCP 外部工具 | Gemini / Qwen / Codex | `mcp.py`（stdio，命名空间 + 审批） |
| 独立 Goal 判断器 | 课程 17.py / ZCode「验证后再结束」 | `GoalEvaluator` |
| mock provider + headless JSON | ZCode | `--provider mock`、`--json -p` |

这些项目的许可证、模型能力和沙箱实现各不相同；EdaCode 只采用公开文档中可解释的架构方法，没有复制其源码或品牌。

## 验证

在项目目录下执行（Windows 的 Git Bash 与 macOS/Linux 通用）：

```bash
# 全部单元测试（含会话锁、shell、进程超时、MCP 端到端、自定义命令与 @ 引用）
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src python -m unittest discover -s tests -v

# 离线冒烟：单次执行 + JSON 输出
python run.py --provider mock --workspace . --json -p "列出当前文件"

# 离线冒烟：交互命令流
printf '/status\n/mcp\n/commands list\n/tools\n/quit\n' | python run.py --provider mock --workspace . --no-stream
```

## 目录

```text
edacode/
  run.py                  # 源码 checkout 直接运行
  pyproject.toml          # 可编辑安装和 edacode 命令
  .env.example
  src/edacode/
    cli.py                # REPL 和 slash 命令
    config.py             # provider、模式、上限配置
    compat.py             # 文件锁 / shell 探测 / 进程树终止的平台分支
    providers.py          # Anthropic/OpenAI/mock
    engine.py             # 主循环、Goal、memory、上下文
    context.py            # 工具事务配对、摘要与可恢复压缩
    tools.py              # 工具 schema、glob 匹配和实现
    commands.py           # 自定义斜杠命令与 @ / !{} 注入
    mcp.py                # 外部 MCP stdio 客户端
    permissions.py        # policy gate
    processes.py          # 进程组和后台 job
    storage.py            # snapshot、events、artifact、锁
  tests/
    test_edacode.py       # 单元与端到端测试
    mcp_echo_server.py    # 测试用的最小 MCP server
  docs/
    lessons.md            # 01.py–17.py 逐脚本经验映射
    research.md           # GitHub 开源 agent 调研与取舍
```

## 当前边界

已实现：stdio MCP、自定义命令与 `@` / `!{}` 注入、Windows/POSIX 跨平台。

未实现（保留边界，避免把"有一个同名工具"误报成完整功能）：

- checkpoint / restore：Gemini CLI 那种"文件 + 对话一起回滚"依赖影子 Git 仓库，与"不自动操作 Git"的边界冲突，需要先定协议。
- `10.py` 的依赖任务图、`12.py` 的 Cron、`13.py` 的多队友 worktree、`15.py` 的完整集成：都需要独立生命周期和更严格的审批测试。
- MCP 只做了 stdio，HTTP/SSE transport 未实现。
- 没有 OS 级沙箱：`auto` 模式下 shell 以当前用户身份运行在工作区目录，只适合信任的项目。需要更强隔离时应在容器、虚拟机或自带 sandbox 的 agent 中运行。
