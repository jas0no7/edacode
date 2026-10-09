# Node.js 0.2.0 验证记录

日期：2026-10-09。执行环境：macOS / Apple Silicon。

- TypeScript strict 编译通过，发布入口具备 Node shebang 和可执行权限。
- Node.js 24.14.0：109 项单元及集成测试通过，0 失败、0 跳过。
- Node.js 22.14.0：同一套 109 项测试通过，覆盖最低支持版本。
- 本地 Anthropic Messages / OpenAI Chat Completions 的 HTTP 与 SSE 编码流程：创建、读取、修改文件后执行 Node 断言，协议与工具结果配对正确；无需真实模型密钥。
- 限流重试、部分流式输出后的网络失败、SIGINT 取消请求、取消后继续会话均有回归测试。
- MCP stdio 握手、工具发现、调用失败、权限拒绝、超时、提前退出、回合取消清理和重新初始化均通过。
- Python v1 真实 JSON fixture：中文、浮点数、数字键顺序、备份、哈希验证、异常检查点拒绝、迁移中断重试、项目记忆及未完成调用恢复均通过。
- 实际 npm tarball 在隔离全局 prefix 中安装后，验证版本命令、另一目录的默认工作区、含空格及中文路径、REPL、多行/管道输入、JSON、显式工作区和卸载；项目内没有生成 node_modules。
- 实际 PTY 中验证自定义命令 shell 审批、确认输入及输入处 Ctrl-C 退出。
- 无密钥进入 CLI，`/connect` 配置两个 provider 的密钥、Base URL、模型；保存后首个任务及再次配置即时生效，原有配置优先级保持不变。
- 模型发现覆盖两种认证、Anthropic 分页、中转站列表格式、路径归一化、列表缓存与刷新、错误/空列表手动输入、超时、中断及重定向凭据保护。无模型 ID 时可启动，通过 `/model` 按编号选择、保存并应用到实际推理请求。
- 重新安装实际 tarball 后，在独立工作目录的 PTY 中完成 `/connect` 自动获取列表、留空保存接口、`/model` 选型、实际请求选中模型、刷新、取消选择、按编号切换及退出；模型持久化且密钥不回显、不进入会话。
- 实际 PTY 中验证密钥输入隐藏、取消向导、随后执行斜杠命令和正常退出；密钥不回显、不进入历史或会话，取消时丢弃 readline 编辑缓冲及 kill ring。
- 生产依赖 npm audit：0 个已知漏洞。

## 待外部环境验证

GitHub Actions 已配置 macOS/Linux/Windows × Node.js 22.14/24 的测试及打包安装矩阵，但本次没有在 Linux/Windows 主机上实际执行，也没有触发远端 CI。

真实模型服务的编码任务未调用；SDK 兼容性用本地服务验证。Windows 的 shell 回退、cmd 启动脚本及 taskkill 分支由 Windows CI 验证。Python 与 Node.js 版本不能同时操作同一会话，迁移为单向。

npm 公共发布需要维护者登录账号并完成 npm 要求的发布验证；本次未发布到 registry。提交或推送这些改动后可查看跨平台 CI 结果，再执行 README 中的发布步骤。
