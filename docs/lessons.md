# 01.py–17.py 学习记录

这份记录按源码和仓库中的 `readme.md`、`09-notes.md`、`13-notes.md`、`17-notes.md` 对照整理。脚本是逐课演进样例，不应把每个文件的重复实现直接拼成生产程序；`edacode` 重新划分了 provider、宿主、工具、策略和存储边界。

| 脚本 | 读到的做法 | 留下的经验 | EdaCode 的处理 |
| --- | --- | --- | --- |
| `01.py` | Anthropic Messages API、单一 `run_bash`、循环保留 messages、失败后回到输入 | 最小模型→工具→结果 loop 清楚易懂 | `providers.py` 保留 API 边界，`engine.py` 统一轮次上限和错误状态 |
| `02.py` | `safe_path`、`read_file/write_file/edit_file/glob` 专用工具、名称分发表 | 专用工具比让模型拼 shell 更易校验 | `tools.py` 增加真实路径、软链接、`.git`、大小和编码检查 |
| `03.py` | deny list、破坏性命令规则、工作区外路径审批 | 拒绝、询问、执行要分层 | `permissions.py` 提供 `plan/ask/edit/auto`；shell 仍明确不是 OS 沙箱 |
| `04.py` | `UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`Stop` hooks | hooks 是宿主扩展点，不能散落在每个工具里 | `engine.Hooks` 保留四类事件，并把 hook 异常写事件日志 |
| `05.py` | `TodoManager` 解析/校验状态，连续工具轮次提醒更新 todo | 计划状态是上下文的一部分，不是模型口头承诺 | `update_plan` 持久化到 session snapshot，并限制最多一个进行中步骤 |
| `06.py` | `task` 子 agent 使用独立消息历史和基础工具 | 子任务结果应回传摘要，不能污染父上下文 | `delegate` 为每个任务建立独立 Store、provider、只读 policy，并保留子 session ID |
| `07.py` | 扫描 `skills/*/SKILL.md`，system 只放目录，`load_skill` 按需读取正文 | skill 目录索引与正文加载应分开 | `Tools.discover_skills/load_skill` 保持同一规则，并限制大小/路径 |
| `08.py` | 超大 tool result 归档、历史 snip、微压缩、最终摘要 | 压缩不能拆开 tool_use/tool_result，原文要可恢复 | `context.py` 以完整消息单元压缩，旧记录写 artifact，压缩模型只看数据 |
| `09.py` | `.memory` 单文件、索引、相关性选择、回合后提取和合并 | 记忆必须是显式可审计事实，当前请求优先 | `Memory` 只接受用户主动 `/memory add`，按关键词召回，文件锁保护写入 |
| `10.py` | 每任务 JSON、依赖环检查、claim/complete、原子更新 | 任务图的发现和认领要分离并可恢复 | 首版用 `update_plan`，任务图保留为后续独立模块，避免伪造完整并发语义 |
| `11.py` | 后台 Bash、进程组、超时、结果通知、退出清理 | 后台作业必须有显式状态和结束通知 | `processes.py` 管理 job ID、输出限额、超时、进程组和 Ctrl-C 清理；重启不恢复进程 |
| `12.py` | 本地 Cron 表达式、持久化任务、交付队列、空闲时执行 | 调度线程不能和交互回合争抢同一会话锁 | 首版不实现 Cron；先保证前后台 job 的生命周期，避免把一次性轮询叫持久调度 |
| `13.py` | Lead/teammate、任务板、mailbox、worktree、类型化审批 | 多 agent 需要身份、工作目录、版本和协议状态 | `delegate` 只做独立只读调查；worktree、团队写入和合并留给后续版本 |
| `14.py` | MCP server 发现、规范化工具名、动态 tool pool、host policy | 外部工具定义不能自动等于授权 | `mcp.py` 用 stdio JSON-RPC 实现发现与调用，工具名规范化为 `mcp__server__tool`，调用仍走 Policy 审批；HTTP/SSE transport 未实现 |
| `15.py` | 把 tools/hooks/memory/tasks/team/MCP/background/Cron 统一到 integrated harness | 组件越多越需要单一生命周期和错误边界 | `engine.py` 只接入已验证的基础组合；后续功能需要各自协议测试 |
| `16.py` | 固定 workflow registry、schema 校验、journal、快照、resume、parallel/pipeline | 模型只能调用宿主已注册原语，不能提交任意可执行脚本 | session event/snapshot 和结构化 provider 已先落地；workflow registry 另开 API |
| `17.py` | 主 Agent 停止后由无工具 evaluator 检查 Goal；未完成继续，失败保留 | “没有 tool call”不等于任务完成；判断器失败不能宣称完成 | `GoalEvaluator` 只读对话证据，`goal_failed`/`error` 保留 Goal 记录并交还控制权 |

## 发现的实现陷阱

1. 05–15 的文件大量复制前一课代码；修一个安全边界容易漏掉后续脚本。EdaCode 因此只有一个工具注册表和一个宿主循环。
2. 08/15 的简化压缩示例如果按 `messages[-N:]` 截断，可能留下没有结果的 tool call；EdaCode 用 `context.units()` 先验证并按完整事务压缩。
3. 12 的定时任务和 11 的后台任务都需要进程级生命周期；把一个线程函数直接放进交互 loop 会导致重复交付、退出泄漏或阻塞输入。
4. 13 的 worktree 是协作隔离，不是 shell 沙箱；EdaCode 文档明确区分审批策略和 OS 隔离。
5. 17 的 evaluator 没有工具，证据只能来自当前对话；EdaCode 强制模型把命令、退出码和验证结果写入消息，并在判断异常时保留 Goal。

