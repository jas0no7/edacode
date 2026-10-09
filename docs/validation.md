# 验收记录

日期：2026-10-09。运行环境：macOS、Python 3.10。

## 已运行

在 `scode/` 下执行：

```bash
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -W error::ResourceWarning -m unittest discover -s edacode/tests -q
.venv/bin/python -m pip check
.venv/bin/edacode --version
```

结果：**64 项测试全部通过，无跳过**；依赖检查通过；命令版本为 `0.1.0`。已在项目 `.venv` 中完成可编辑安装，Anthropic SDK 为 `1.9.0`，OpenAI SDK 为 `2.32.0`。这些是本轮验证版本，包声明仍允许兼容的其他版本。

覆盖范围：

- 文件路径和软链接边界、读后修改、冲突检测、撤销、检查点，以及丢弃旧分支后拒绝恢复其检查点。
- 工具 JSON 参数、非零退出码、截断输出、重复调用 ID、中断后补齐结果且不重放写入。
- Goal 判断异常保留目标、未完成时继续、子 agent 的消息和存储隔离。
- 上下文压缩保留完整工具配对、摘要失败时归档原文并保留当前用户目标。
- MCP stdio 握手与工具调用、启动权限、错误结果、进程资源清理。
- 自定义命令、参数替换、shell 参数转义、注入内容不递归执行、配置回退与界面降级。
- shell 超时和组长退出后遗留子进程的清理。

`test_provider_http.py` 使用真实 SDK 连接本机临时 HTTP/SSE 模拟服务，分别验证两个 provider 的流式和非流式路径。每条路径完整执行 `write_file → read_file → edit_file → shell → final`，最后断言 Python 文件中的值确实已改变、验证命令退出码为 0。该测试不访问真实模型，不产生模型费用。

另以临时工作区和状态目录进行了命令行验收：

- 从安装目录以外的目录启动 `edacode`。
- `--provider mock --json -p` 的 stdout 可解析为单个 JSON。
- `--resume latest` 延续相同主会话。
- REPL 的 `/status`、`/mode`、`/commands`、`/mcp`、`/checkpoint`、`/restore`、`/quit`。
- 管道模式无 ANSI 控制字符，缺少 API 配置时返回清晰错误及非零退出码。

## 验证范围

本次未访问真实 Anthropic/OpenAI 或第三方兼容模型网关；当前工作区与用户级 `.env` 均未配置。SDK 报文和工具执行链已验证，模型的实际编码效果、具体网关兼容性和额度尚未验证。

Windows/Linux 分支未在对应系统实机运行。MCP 仅验证了 stdio 工具协议；HTTP/SSE、OAuth、服务端 sampling 等不在当前实现范围。文件检查点不覆盖 shell 或外部 MCP 修改的文件。权限模式不是 OS 沙箱。

其他环境复验时，先在 `edacode/` 安装 `python -m pip install -e '.[openai]'`，再执行 `python -m unittest discover -s tests -v`；缺少某个 SDK 时相应 HTTP 测试会明确标记 skipped。
