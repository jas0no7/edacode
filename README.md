# EdaCode

EdaCode 是一个在终端中协助你检查、修改和验证代码的交互式 coding agent。0.2.0 起使用 TypeScript / Node.js，支持 macOS、Linux、Windows，无需 Python。

## 安装和启动

需要 **Node.js 22.14+**，推荐 Node.js 24 LTS。发布到 npm 后：

```bash
npm install -g edacode
cd /path/to/your/project
edacode
```

**终端当前目录就是工作区**。全局安装不会把当前目录改成 EdaCode 的安装目录，也不需要给每个项目安装依赖。

```bash
edacode --version
edacode --help
edacode --workspace /path/to/another/project
edacode -p "检查并修复测试失败"
edacode --provider mock --json -p "列出文件"  # 不需要密钥的离线安装检查
```

如果 `edacode` 找不到，检查 npm 全局命令目录是否在 PATH 中：macOS/Linux 为 `npm prefix -g` 输出目录下的 `bin`，Windows 为该输出目录本身。若曾安装 Python 版，先用原工具卸载旧命令（例如 `uv tool uninstall edacode` 或 `pipx uninstall edacode`），避免同名入口遮挡。

```bash
npm install -g edacode@latest   # 升级
npm uninstall -g edacode       # 卸载；保留 ~/.edacode 中的配置和会话
```

尚未发布时，也可从本仓库安装：

```bash
npm ci
npm run build
npm install -g .
```

## 模型配置

可以先运行 `edacode`，无需预先配置。进入 CLI 后输入：

```text
/connect
```

按提示选择 Anthropic 或 OpenAI 兼容接口，输入 API key 和 Base URL，即可自动获取可用模型列表，按编号或模型 ID 选择。也可留空先保存接口配置，再通过 `/model` 选择模型。API key 输入时隐藏；Base URL 留空使用官方地址。支持根地址、`/v1` 地址或完整的 `/v1/chat/completions`、`/v1/messages` 地址，模型查询与实际推理共用归一化后的地址。

配置保存到 `~/.edacode/.env`（Windows 对应 `%USERPROFILE%\.edacode\.env`），当前会话立即生效，配置一次即可跨项目使用。`/connect openai` 或 `/connect anthropic` 可直接选择接口，也可重新运行向导更新配置；Ctrl-C 取消向导且不保存。软件不附带模型服务或 API key。

```text
/model                 显示模型列表并按编号或 ID 选择
/model 2               切换到列表中的第二个模型
/model your-model-id   直接指定模型 ID，无须查询列表
/model list            仅显示列表
/model refresh         重新获取模型列表
```

模型选择会保存到用户配置，立即生效。列表按当前接口、密钥和地址在本次进程中缓存五分钟，刷新或重新配置后更新。非交互输入只显示列表，不等待选择，可用后续 `/model <编号或 ID>` 切换。

模型发现对接 [OpenAI Models API](https://developers.openai.com/api/reference/resources/models/methods/list) 和 [Anthropic Models API](https://platform.claude.com/docs/en/api/models)。列表代表服务返回的模型；具体模型是否支持当前接口和工具调用，以实际请求结果为准。服务未提供列表接口、返回错误或列表为空时，仍可手动输入模型 ID；查询超时十秒（或更短的已配置请求超时），可按 Ctrl-C 中断。

也可手动创建配置文件。Anthropic 示例：

```dotenv
EDACODE_PROVIDER=anthropic
ANTHROPIC_API_KEY=your-api-key
EDACODE_MODEL=your-model-id
# ANTHROPIC_BASE_URL=https://your-compatible-endpoint
```

OpenAI Chat Completions 兼容接口示例：

```dotenv
EDACODE_PROVIDER=openai
OPENAI_API_KEY=your-api-key
EDACODE_MODEL=your-model-id
# OPENAI_BASE_URL=https://your-compatible-endpoint/v1
```

两个 provider 的 SDK 已包含在 npm 依赖中，无需额外安装。完整选项见包中的 `.env.example`；也保留 `MODEL_ID` 作为模型配置兼容项。

配置优先级：

1. 已导出的环境变量。
2. 工作区根目录 `.env`。
3. 用户级 `~/.edacode/.env`，只补充前两级没有的变量。

`--env-file /path/to/file` 只加载指定文件，导出的环境变量仍优先。`--home` 或 `EDACODE_HOME` 可修改状态目录。向导保存到用户配置，当前会话使用刚输入的设置，下次启动仍按上述优先级加载。缺少模型或密钥也能进入交互界面，执行任务时会提示 `/connect` 或 `/model`；单次执行 `-p` 缺少配置时仍返回退出码 2。可用 `--provider mock` 离线检查安装；mock 只做确定性的文件列举，不模拟真实编码能力。

## 交互与权限

输入自然语言任务即可开始；使用 `@路径` 引用工作区文件或目录，行尾反斜杠可继续输入下一行。

```text
/help
/status
/connect [anthropic|openai]
/mode plan|ask|edit|auto
/model [编号|模型ID|list|refresh]
/goal <可验证的完成条件>
/goal clear
/tools
/jobs
/cancel <job_id>
/diff
/undo
/checkpoint [标签]
/restore [ID|latest]
/compact
/clear
/sessions
/memory list|add <文本>|clear
/mcp
/commands list|reload
/quit
```

| 模式 | 文件写入 | shell / MCP 启动与调用 |
| --- | --- | --- |
| `plan` | 拒绝 | 拒绝 |
| `ask` | 每次审批 | 每次审批 |
| `edit`（默认） | 自动执行 | 每次审批 |
| `auto` | 自动执行 | 自动执行 |

审批展示完整 diff 或操作内容；非交互输入和 `-p` 不会代替用户批准操作。危险 shell 模式始终硬拒绝。权限策略不是操作系统沙箱，shell 仍以当前用户身份运行。

已有文件必须先读取才能修改；读取后文件发生变化、审批期间被外部修改或路径越界时拒绝覆盖。文件发现过滤 `.git`、依赖/构建目录、敏感 `.env` 和 `.edacodeignore` 指定项；显式文件读取不受发现过滤影响。

Ctrl-C 在执行任务时取消当前回合并保存会话，在输入处退出。前后台命令默认超时 120 秒、最多四个并发作业、输出上限 2 MB；退出时清理本进程启动的命令和 MCP server。Windows 优先使用 `EDACODE_SHELL` 或 Git Bash，找不到 Bash 时回退 `cmd.exe`。

界面保留像素 logo、输入提示和状态栏。非 TTY、重定向或设置 `NO_COLOR` 时使用纯文本；`--no-banner` 跳过欢迎屏，`--no-stream` 关闭流式输出。

## 会话、检查点和旧数据

状态保存在 `~/.edacode/projects/<工作区哈希>/sessions/`，每个工作区独立。

```bash
edacode --resume latest
edacode --resume <session-id>
```

会话包含对话、工具结果、计划、Goal、文件前镜像和检查点。首次实际写文件时保存当前回合起点；`/checkpoint` 可手动记录，`/restore` 回滚文件、计划和 Goal，并在历史分支仍匹配时回滚对话。外部改动的文件跳过，压缩后不错误截断对话。恢复会话不会盲目重放中断时执行状态未知的工具，也不恢复已经结束的后台进程。

Node.js 版首次恢复 Python v1 会话时，先将会话目录完整复制到其 `legacy-v1-backup/`，验证旧检查点哈希后写入 v2 格式。中文、浮点数表示、数字键顺序均参与旧哈希验证；无法验证的检查点会拒绝恢复。超出 JavaScript 安全整数范围的旧整数会阻止自动迁移，保留原数据。项目记忆位置保持不变。

这是**单向迁移**，v2 会话由新版继续维护。迁移前结束旧 Python 进程，不要让两版同时操作同一会话；保留原始备份供人工恢复。Python 源码保留在 `src/edacode/` 作参考，旧文档见仓库中的 [Python 版说明](docs/python-reference.md)，均不包含在 npm 包中。

## 自定义命令、项目规范和技能

Markdown 命令从两处加载，同名时项目级优先：

```text
<工作区>/.edacode/commands/
<状态目录>/commands/
```

`git/commit.md` 对应 `/git:commit`。支持 `$ARGUMENTS`、`{{args}}`、`$1`…`$9`、`${1}` 参数，以及 `@{path}` 文件/目录注入和 `!{command}` shell 注入。例如：

```markdown
---
description: 审查指定文件
argument-hint: <path>
---
请审查 $1。
@{$1}
```

只解释原始模板一次，文件内容、参数和命令输出不会再次变成注入指令；shell 块按模板顺序执行并走权限审批。shell 参数会转义为一个字面量，占位符必须位于引号外；不支持参数化 heredoc。有参数的 shell 模板需要 Bash。

自动加载工作区根目录的 `AGENTS.md`、`GEMINI.md`、`EDACODE.md`；读取文件时带上子目录 `AGENTS.md`。从 `skills/*/SKILL.md` 和 `.edacode/skills/*/SKILL.md` 发现可按需加载的技能。

## 外部 MCP

在工作区根目录 `mcp.json` 或 `.edacode/mcp.json` 配置 stdio server，根目录配置优先：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/project"]
    }
  }
}
```

使用 JSON-RPC over stdio，协议版本 `2024-11-05`。工具命名为 `mcp__<server>__<tool>`；启动和调用分别检查权限，单个 server 失败不影响内置工具及其他 server。只读子 agent 不加载 MCP。

## 开发和验证

```bash
npm ci
npm test                # 编译、单元和本地 HTTP/SSE/MCP 集成测试
npm run test:package    # 真实 tarball、隔离全局安装、跨目录启动、卸载
npm start -- --provider mock
```

源码在 `src/node/`，编译产物在 `dist/`。测试使用本地模拟服务，不需要真实模型密钥，也不需要 Python。GitHub Actions 配置了 macOS/Linux/Windows × Node.js 22.14/24 的测试与安装包验证矩阵；实际运行结果以 Actions 为准。

## 发布到 npm

推送 GitHub 和发布 npm 是两个步骤。首次发布者需拥有 npm 账号，并按 npm 当前要求完成账号及发布验证。参考 [npm 官方发布指南](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/)。

在仓库根目录执行：

```bash
npm ci
npm test
npm run test:package
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
npm publish --access public
```

`prepublishOnly` 会再次运行测试和安装包检查，`prepack` 会构建运行产物。只打包 `dist/`、配置示例、README、许可证及 npm 必要的包元数据，不发布密钥、会话、Python 源码和开发记录。用 `npm pack --dry-run` 可查看文件清单。

首次包名使用 `edacode`；发布时若名字已被占用，需要先解决包名或所有权问题。CI 只构建和测试，不自动发布。

## 许可证

MIT。架构背景和早期研究保留在仓库的 `docs/` 中。
