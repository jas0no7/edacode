# 开源 agent 研究记录

调研日期：2026-10-08，2026-10-09 复核。主要依据公开仓库 README 和官方架构文档，未运行或完整审计上游项目，未复制上游源码。下面区分文档事实与 EdaCode 自己的设计选择。

## OpenAI Codex CLI

- 仓库：[openai/codex](https://github.com/openai/codex)
- 仓库说明它是运行在本地终端的 coding agent，并将项目指令、文档和本地运行边界作为核心体验。
- 可借鉴：显式批准模式、项目级 `AGENTS.md`、本地文件修改与命令执行分开、任务结束前显示验证结果。
- EdaCode 对应：`plan/ask/edit/auto`，读取 `AGENTS.md`，工作区文件采用 SHA256 + diff + 二次冲突检查。EdaCode 的 `auto` 不是 Codex 的 sandbox，README 已明确这一差异。

## OpenCode

- 仓库：[anomalyco/opencode](https://github.com/anomalyco/opencode)
- agent 文档：[agents.mdx](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/agents.mdx)
- 文档区分主 agent 与子 agent。Plan 通过权限策略控制行为，文件编辑与 Bash 默认为 ask；EdaCode 选择了更窄的 plan 边界，直接禁止写入和 shell。
- 可借鉴：主 agent、只读探索 agent、外部资料 agent 的职责分离；配置文件只描述权限和系统提示。
- EdaCode 对应：主 Engine、`plan`、只读 `delegate`，子任务单独 session，不共享父 messages。

## Gemini CLI

- 仓库文档：[gemini-cli/docs/index.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/index.md)
- 官方文档把 slash commands、session/history、memory、skills、todo、hooks、MCP、checkpoint、headless 和 plan mode 都作为独立能力列出。
- 可借鉴：交互控制面不能只靠自然语言；恢复、压缩、技能重载和脚本化入口都应有明确命令。
- EdaCode 对应：`/help`、`/status`、启动参数 `--resume`、`/memory`、`/compact`、`/tools`、`--prompt --json`；技能以目录索引、按需正文加载。

## Qwen Code

- 架构：[architecture.md](https://github.com/QwenLM/qwen-code/blob/main/docs/developers/architecture.md)
- 子 agent：[sub-agents.md](https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/sub-agents.md)
- 架构文档区分直接执行和 ACP/daemon 等运行面；子 agent 文档强调独立上下文、受控工具、前台/后台结果和可复用 Markdown 配置。
- 可借鉴：provider 与宿主解耦、子 agent 的工具 allowlist、任务结果通知不能伪造原始 tool result。
- EdaCode 对应：`providers.py` 适配 Anthropic/OpenAI-compatible/mock；只读子 agent 只有 read/search/skill/artifact 工具，结果会附独立 session ID。

## ZCode / zcode

- Z.ai CLI：[apps/zcode-cli/README.md](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/README.md)
- Zig CLI：[Softorize/zcode](https://github.com/Softorize/zcode)
- 这是两个不同项目。Z.ai CLI 的 README 展示了 CLI/core/UI 分层，以及可贡献 skills、Markdown commands 和 MCP servers 的本地插件。
- Softorize 的 Zig CLI README 描述了 `assistant + tool_calls + control` 协议、mock provider、验证后结束、policy/audit 和 headless 入口。这里只记录文档声明，不代表已经验证其实现或成熟度，也不将这些能力归给 Z.ai。
- EdaCode 的取舍：从 Z.ai 的目录分层学习宿主与界面分离；从 Zig CLI 的设计描述学习确定性 mock 与可脚本化入口；Goal 判断器的直接来源是课程 `17.py`。
- EdaCode 对应：`--provider mock`、`--json -p`、事件日志、tool 结果配对校验、Goal 独立完成检查；stdio MCP 客户端（`mcp.py`）已接入，命名空间化工具并保留审批。HTTP/SSE transport、fallback routing 和 CI policy bundle 仍未实现。

## 第二轮调研：命令、上下文注入与权限模型

补充调研日期：2026-10-08。目标是从官方文档里找出 EdaCode 当时**完全没有**的机制。

### Gemini CLI：custom commands

来源：[custom commands](https://geminicli.com/docs/cli/custom-commands)

- 命令是文件，两处加载：用户级 `~/.gemini/commands/`、项目级 `<project>/.gemini/commands/`；**同名时项目覆盖用户**。
- 命名：子目录路径用 `:` 连接，`git/commit.toml` → `/git:commit`。
- 占位符：`{{args}}` 注入全部参数；正文不含占位符时，参数追加到 prompt 末尾。
- 注入：`!{shell}` 注入命令输出（执行前弹确认），`@{path}` 注入文件内容或目录清单。
- 处理顺序：文件注入 → shell 注入 → 参数替换。

EdaCode 采纳：`commands.py` 用 Markdown，保留两级目录、`:` 命名空间、参数与文件/shell 注入。实现上先识别原始模板的块，再按顺序分别替换参数、读取或执行；新增文本不再解析，避免文件正文或参数成为新的 shell 块。shell 参数自动按字面量转义，要求占位符在引号外；执行统一经过 `tools.call('shell', ...)` 和 Policy。Gemini 文档要求 TOML；Markdown 是 EdaCode 的选择。

### Gemini CLI：`@` 文件引用

来源：[custom commands](https://geminicli.com/docs/cli/custom-commands) 第 4 节

- `@{path}` 注入文件内容，目录会展开其中的文件内容（尊重 ignore 配置）。EdaCode 对目录只插入清单，控制上下文体积。
- EdaCode 采纳：`commands.inject_references` 额外支持普通输入里的裸 `@path`，但**只替换能解析到工作区内真实路径的 token**，避免误伤 `a@b.com`。

### Gemini CLI：checkpoint / restore

来源：[checkpointing](https://geminicli.com/docs/cli/checkpointing)

- 每次批准写文件前自动打 checkpoint：一个影子 Git 仓库快照（`~/.gemini/history/<hash>`）+ 完整对话历史 + 待执行的 tool call。
- `/restore` 同时回滚文件与对话，并重新提出原来的 tool call。
- 需要显式开启（`settings.json`），且依赖 Git。

EdaCode 现状：**已实现回合级 checkpoint / restore**。做法与 Gemini CLI 不同——不建影子 Git 仓库，而是复用文件编辑时已经记录的改动前镜像（`changes[].before`）和会话里的 `messages_len` / `generation` / `todos` / `goal` 锚点，回滚时不复制整份消息体。`/restore` 同时回滚文件、对话、计划与 Goal；被外部改过的文件跳过不覆盖；发生过上下文压缩（`generation` 变化）时拒绝回滚对话，只回滚文件。这样既拿到了"文件 + 对话一起回滚"的能力，又守住了"不自动操作 Git"的边界。

复核补充：检查点也保存对话前缀的摘要哈希；回滚后另起分支时，旧分支的检查点不能按相同消息长度截断新对话。

### Codex / Gemini：权限与沙箱模型

- Codex 的 `approval_policy`（untrusted / on-failure / on-request / never）与 `sandbox_mode`（read-only / workspace-write / danger-full-access）是两件独立的事：**审批决定"问不问"，沙箱决定"能碰什么"**。
- EdaCode 提供 `plan/ask/edit/auto` 审批策略和文件工具的路径检查，没有 OS 沙箱。MCP 进程启动本身也需要批准，不能等到工具调用时才审批。

结论：这一层保持现状，不引入假沙箱。

## 跨平台补充

EdaCode 最初按 macOS/Linux 编写，直接使用 `fcntl.flock`、`os.killpg`、`/bin/bash`。在 Windows 上这些 API 不存在，因此把平台分支收敛到 `compat.py`：

- 文件锁：POSIX `fcntl.flock` ↔ Windows `msvcrt.locking`（会话锁与记忆文件锁共用）。
- shell：POSIX 固定 `/bin/bash -c`；Windows 探测 `EDACODE_SHELL` → PATH 中的 `bash` → Git 安装路径，找不到才回退系统 shell（此时用 `shell=True`）。
- 进程终止：POSIX `killpg(SIGKILL)` ↔ Windows `taskkill /F /T /PID`。
- 原子写入在 Windows 覆盖只读目标前先清除只读属性。
- 相对路径统一用 POSIX 分隔符：否则 `Path` 在 Windows 给出反斜杠，`src/**/*.py` 这类 pattern 和 `@目录` 前缀过滤会静默失效。

## 取舍

这些项目的语言、模型 API、sandbox、授权体系不同；直接复制某个实现会把其运行时假设带进当前 Python 项目。EdaCode 先实现可验证的公共内核：结构化消息、单一工具边界、会话锁、文件冲突保护、进程组清理和可解释权限模式；已接入的部分是自定义命令、`@` 注入、stdio MCP 和回合级 checkpoint/restore。仍未实现的是 worktree/团队、Cron、统一 harness、MCP 的 HTTP/SSE transport，以及真正的 OS 级沙箱。
