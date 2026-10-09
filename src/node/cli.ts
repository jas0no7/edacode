#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { HELP, TIPS } from './constants.js';
import { loadConfig, modelReady, requireModelConfig } from './config.js';
import { connectModel, chooseModel, type ConnectionPrompt } from './connection.js';
import { Engine } from './engine.js';
import { Store, encode, listSessions } from './storage.js';
import { discoverCommands, expand, injectReferences } from './commands.js';
import { Palette, supportsColor, safeTerminal, promptText, VERSION, welcome } from './ui.js';
import { FullScreen, type PromptInput } from './tui.js';
import type { Config, Result } from './types.js';
export function parseArgs(argv: string[]): Record<string, any> {
  const args: Record<string, any> = {workspace: '.', query: []};
  const flags = new Set(['json', 'no-stream', 'no-banner', 'no-tui', 'version', 'help']);
  const values = new Set(['prompt', 'workspace', 'env-file', 'home', 'provider', 'model', 'mode', 'max-turns']);
  const short: Record<string, string> = {'-p': '--prompt', '-h': '--help'};
  for (let i = 0; i < argv.length; i++) {
    let token = short[argv[i]] || argv[i];
    if (token === '--') { args.query.push(...argv.slice(i + 1)); break; }
    if (!token.startsWith('-')) { args.query.push(token); continue; }
    const equals = token.indexOf('='); const inline = equals >= 0 ? token.slice(equals + 1) : undefined;
    if (equals >= 0) token = token.slice(0, equals);
    if (!token.startsWith('--')) throw new Error('未知参数：' + token);
    const name = token.slice(2), key = name.replaceAll('-', '_');
    if (flags.has(name)) { if (inline !== undefined) throw new Error(`${token} 不接受值`); args[key] = true; }
    else if (name === 'resume') { args.resume = inline ?? (argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : 'latest'); }
    else if (values.has(name)) {
      const value = inline ?? argv[++i]; if (value === undefined || (inline === undefined && value.startsWith('--'))) throw new Error(`${token} 需要一个值`);
      args[key] = name === 'max-turns' ? Number(value) : value;
    } else throw new Error('未知参数：' + token);
  }
  if (args.json && args.prompt === undefined) throw new Error('--json 需要同时提供 -p');
  if (args.prompt !== undefined && args.query.length) throw new Error('位置任务与 -p 不能同时使用');
  args.no_stream ||= args.json; return args;
}
export const CLI_HELP = `EdaCode ${VERSION} 独立交互式编码 agent\n\n用法：edacode [参数] [启动任务]\n\n-p, --prompt <任务>       单次执行并退出，不从 stdin 读取审批\n--json                    配合 -p，stdout 只输出一个 JSON 对象\n--workspace <目录>        默认当前目录\n--env-file <文件>         显式配置文件\n--home <目录>             状态目录，默认 ~/.edacode\n--provider <provider>     anthropic | openai | mock\n--model <模型ID>\n--mode <权限模式>         plan | ask | edit | auto\n--resume [ID|latest]      恢复会话\n--max-turns <次数>\n--no-stream               禁用流式输出\n--no-banner               跳过欢迎屏\n--no-tui                  使用逐行终端交互\n--version                 输出版本\n-h, --help                查看帮助\n`;
/** 逐行队列在初始化时就接收管道输入，审批和 REPL 共用一个读取器。 */
export class Input {
  rl!: readline.Interface; private queue: string[] = []; private ended = false;
  private output: Writable;
  private secret = false;
  private resetting = false;
  private waiting?: {resolve: (line: string | undefined) => void; reject: (error: any) => void};
  onInterrupt: () => void = () => {};
  constructor(private source: NodeJS.ReadStream = process.stdin, private target: NodeJS.WriteStream = process.stdout) {
    this.output = new Writable({write: (chunk, encoding, callback) => {
      if (this.secret) callback(); else this.target.write(chunk, encoding, callback);
    }});
    Object.defineProperties(this.output, {isTTY: {get: () => this.target.isTTY}, columns: {get: () => this.target.columns}});
    this.createReader();
  }
  private createReader(): void {
    this.rl = readline.createInterface({input: this.source, output: this.output, terminal: !!this.source.isTTY && !!this.target.isTTY});
    this.rl.on('history', history => { if (this.secret) history.splice(0); });
    this.rl.on('line', line => { if (this.waiting) { const {resolve} = this.waiting; this.waiting = undefined; resolve(line); } else this.queue.push(line); });
    this.rl.on('close', () => { if (this.resetting) return; this.ended = true; this.waiting?.resolve(undefined); this.waiting = undefined; });
    this.rl.on('SIGINT', () => this.onInterrupt());
  }
  async read(prompt: string, signal?: AbortSignal, secret = false): Promise<string | undefined> {
    signal?.throwIfAborted();
    if (this.queue.length) return this.queue.shift(); if (this.ended) return;
    if (secret) {
      this.target.write(safeTerminal(prompt)); this.secret = true;
      this.rl.setPrompt(''); this.rl.prompt();
    } else if (this.source.isTTY) { this.rl.setPrompt(safeTerminal(prompt)); this.rl.prompt(); }
    let abort: (() => void) | undefined;
    try {
      return await new Promise((resolve, reject) => {
        this.waiting = {resolve, reject}; abort = () => { this.waiting = undefined; reject(signal?.reason); };
        signal?.addEventListener('abort', abort, {once: true});
      });
    } finally {
      if (abort) signal?.removeEventListener('abort', abort);
      if (secret || signal?.aborted) {
        // 丢弃 readline 的整条编辑缓冲、历史和 Ctrl-Y kill ring，避免取消后的密钥成为任务输入。
        this.resetting = true; this.rl.close(); this.resetting = false;
        if (signal?.aborted) this.queue.length = 0;
        if (!this.ended) this.createReader();
        this.secret = false; this.target.write('\n');
      }
    }
  }
  close(): void { this.rl.close(); }
}
export class Terminal {
  streaming = false;
  constructor(public input: PromptInput, public quiet = false, public interactive = true, public palette = new Palette(false), public signal: () => AbortSignal | undefined = () => undefined) {}
  display = (kind: string, value: string): void => {
    if (!this.quiet && this.input instanceof FullScreen) { this.input.display(kind, value); return; }
    if (this.quiet) return; const text = safeTerminal(value), p = this.palette;
    if (kind === 'stream') { if (!this.streaming) { process.stdout.write('\n' + p.accent + '助手' + p.reset + ' '); this.streaming = true; } process.stdout.write(text); }
    else if (kind === 'stream_end') { this.streaming = false; process.stdout.write('\n'); }
    else if (kind === 'assistant') process.stdout.write('\n' + p.accent + '助手' + p.reset + ' ' + text + '\n');
    else process.stderr.write(`\n${kind === 'error' ? p.red : p.muted}[${kind}]${p.reset} ${text}\n`);
  };
  confirm = async (name: string, detail: string): Promise<boolean> => {
    if (!this.interactive || !process.stdin.isTTY) return false;
    if (this.input instanceof FullScreen) this.input.approval(name, detail);
    else process.stderr.write(`\n请求执行 ${safeTerminal(name)}：\n${safeTerminal(detail)}\n`);
    const answer = await this.input.read('允许此次操作？[y/N] ', this.signal()); return ['y', 'yes'].includes(answer?.trim().toLowerCase() || '');
  };
}
export async function command(text: string, config: Config, store: Store, engine: Engine, connect?: (provider?: string) => Promise<string>, read?: ConnectionPrompt): Promise<string | Result> {
  const split = text.search(/\s/), name = split < 0 ? text : text.slice(0, split), rest = split < 0 ? '' : text.slice(split).trim();
  if (name === '/help') return HELP;
  if (name === '/connect') {
    if (rest && !['anthropic', 'openai'].includes(rest)) throw new Error('用法：/connect [anthropic|openai]；请在向导中输入密钥');
    if (!connect) throw new Error('/connect 需要交互式终端；单次执行请使用 .env 或环境变量配置');
    return connect(rest || undefined);
  }
  if (name === '/status') return encode({session: store.id, workspace: config.workspace, mode: engine.policy.mode, provider: config.provider, model: config.model,
    messages: engine.messages.length, usage: store.data.usage, goal: engine.goal, todos: store.data.todos, checkpoints: store.data.checkpoints?.length || 0, changes: store.data.changes.length});
  if (name === '/mode') {
    if (!['plan', 'ask', 'edit', 'auto'].includes(rest)) throw new Error('用法：/mode plan|ask|edit|auto');
    config.mode = engine.policy.mode = rest as Config['mode']; store.event('mode_changed', {mode: rest});
    return '权限模式：' + rest + (rest === 'auto' ? '；shell 以当前用户权限执行，工作目录不是沙箱。' : '');
  }
  if (name === '/model') return chooseModel(engine, read, rest);
  if (name === '/goal') {
    if (!rest) return encode(engine.goal);
    if (['clear', 'off', 'stop', 'none', 'cancel'].includes(rest.toLowerCase())) { engine.clearGoal(); return 'Goal 已清除'; }
    engine.setGoal(rest); return engine.run(rest);
  }
  if (name === '/memory') {
    if (rest === 'list') return encode(engine.memory.items);
    if (rest === 'clear') { await engine.memory.update(undefined, true); return '当前工作区记忆已清除'; }
    if (rest.startsWith('add ') && rest.slice(4).trim()) { await engine.memory.update(rest.slice(4).trim()); return '记忆已保存'; }
    throw new Error('用法：/memory list|add <文本>|clear');
  }
  if (name === '/sessions') return listSessions(config).map(x => `${x.id}  ${new Date(x.updated * 1000).toISOString()}  ${safeTerminal(x.title)}`).join('\n') || '无会话';
  if (name === '/jobs') return encode([...(engine.tools.processes?.jobs.values() || [])].map(j => j.poll()));
  if (name === '/cancel') return encode(await engine.tools.processes!.get(rest).stop());
  if (name === '/undo') {
    const result = engine.tools.undo(); engine.messages.push({role: 'user', content: '[用户手动撤销变更] ' + result + '；继续编辑前重新读取文件。'}); store.save(); return result;
  }
  if (name === '/diff') return store.data.changes.slice(-10).map((x: any) => `[${x.status}${x.undone ? '/已撤销' : ''}] ${x.path}\n${x.diff}`).join('\n\n') || '无专用工具文件变更';
  if (name === '/checkpoint') return '已创建检查点：' + store.makeCheckpoint(rest);
  if (name === '/restore') {
    const index = store.data.checkpoints || [];
    if (!rest) return [...index].reverse().map((x: any) => `${x.id}  [${x.kind}] ${new Date(x.time * 1000).toISOString()}  ${safeTerminal(x.label)}  (消息 ${x.messages_len} / 变更 ${x.changes_len})`).join('\n') || '当前会话没有检查点';
    const result = engine.restore(rest === 'latest' ? index.at(-1)?.id : rest);
    return `已回滚检查点 ${result.id}\n${result.conversation}\n文件已回滚：${result.reverted.join(', ') || '无'}` + (result.skipped.length ? '\n跳过：' + result.skipped.map(([p, why]: string[]) => `${p}（${why}）`).join('; ') : '');
  }
  if (name === '/compact') return await engine.context(true) ? '上下文已压缩' : '无须压缩';
  if (name === '/tools') return engine.tools.specs().map(t => `- ${t.name}: ${t.description}`).join('\n');
  if (name === '/mcp') {
    if (!engine.tools.mcp) return '只读子 agent 不加载 MCP';
    return [...engine.tools.mcp.servers.values()].map(s => `- ${s.name}: ${s.tools.length} 个工具`).concat(engine.tools.mcp.errors.map(e => '- 加载失败：' + e)).join('\n') || '未配置 mcp.json（工作区根目录或 .edacode/mcp.json）';
  }
  if (name === '/commands') {
    if (rest === 'reload') { engine.tools.commands = discoverCommands(config.workspace, config.home); return `已重新扫描：${engine.tools.commands.size} 个自定义命令`; }
    if (rest && rest !== 'list') throw new Error('用法：/commands list|reload');
    return [...engine.tools.commands].sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `- /${key}  [${item.source}] ${item.description}` + (item.argument_hint ? `  参数：${item.argument_hint}` : '')).join('\n') || '无自定义命令；在 .edacode/commands/ 或 <home>/commands/ 放 Markdown 文件';
  }
  if (name === '/clear') {
    const archive = store.artifact(encode(engine.messages), 'history'); engine.messages.splice(0); store.data.todos = []; store.data.checkpoints = []; engine.clearGoal(); store.save(); return '对话已清空，旧消息归档：' + archive;
  }
  const custom = engine.tools.commands.get(name.slice(1));
  if (name.startsWith('/') && custom) {
    const prompt = await expand(custom, rest, engine.tools, engine.display); engine.display('info', `自定义命令 ${name} 展开为 ${prompt.length} 字符`); return engine.run(prompt);
  }
  throw new Error('未知命令，输入 /help 查看帮助');
}
export async function main(argv = process.argv.slice(2)): Promise<number> {
  let args: Record<string, any>;
  try { args = parseArgs(argv); } catch (error) { process.stderr.write(`EdaCode 参数错误：${safeTerminal(String(error))}\n`); return 2; }
  if (args.version) { console.log(VERSION); return 0; }
  if (args.help) { process.stdout.write(CLI_HELP); return 0; }
  let store: Store | undefined, engine: Engine | undefined, busy = true;
  const startupController = new AbortController(); const p = new Palette(supportsColor());
  const screen = args.prompt === undefined && !args.no_tui && process.stdin.isTTY && process.stdout.isTTY && process.env.TERM !== 'dumb'
    ? new FullScreen(process.stdin, process.stdout, p, !!args.no_banner) : undefined;
  const input: PromptInput = screen || new Input();
  const terminal = new Terminal(input, !!args.json, args.prompt === undefined, p, () => engine?.signal || startupController.signal);
  const interrupt = () => { if (busy) { if (engine) engine.cancel(); else startupController.abort(new Error('已中断')); } else input.close(); };
  input.onInterrupt = interrupt; process.on('SIGINT', interrupt);
  const terminate = () => { startupController.abort(new Error('已终止')); engine?.cancel(); input.close(); };
  process.on('SIGTERM', terminate);
  try {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 14)) throw new Error('需要 Node.js 22.14+，推荐 Node.js 24 LTS');
    const config = loadConfig(args);
    screen?.setContext(config);
    if (args.prompt !== undefined) requireModelConfig(config);
    store = await Store.open(config, args.resume);
    engine = await Engine.create(config, store, {display: terminal.display, confirm: terminal.confirm, controller: startupController});
    screen?.setContext(config, engine.tools, store.id);
    const submit = async (text: string): Promise<Result> => {
      busy = true;
      screen?.submitted(text);
      if (engine!.signal.aborted) { engine!.controller = new AbortController(); engine!.tools.signal = engine!.signal; }
      try {
        let result = text.startsWith('/') ? await command(text, config, store!, engine!, args.prompt === undefined ? async provider => {
          if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('/connect 需要交互式终端；请直接运行 edacode，或使用 .env 配置');
          return connectModel(engine!, (prompt, secret) => input.read(prompt, engine!.signal, secret), provider);
        } : undefined, args.prompt === undefined && process.stdin.isTTY && process.stdout.isTTY
          ? (prompt, secret) => input.read(prompt, engine!.signal, secret) : undefined) : await engine!.run(injectReferences(text, engine!.tools));
        if (typeof result === 'string') { terminal.display('info', result); result = {status: 'completed', text: result, session: store!.id}; }
        else if (result.reason) terminal.display(result.status, result.reason);
        return result;
      } catch (error) {
        if (engine!.signal.aborted) { await engine!.tools.cancelRunning(); store!.repairPending(); store!.save(); }
        const result = {status: engine!.signal.aborted ? 'cancelled' : 'error', text: '', reason: engine!.errorText(error), session: store!.id}; terminal.display('error', result.reason); return result;
      } finally { busy = false; }
    };
    if (args.prompt !== undefined) {
      const result = await submit(args.prompt); if (args.json) console.log(JSON.stringify({...result, usage: store.data.usage}));
      return result.status === 'completed' ? 0 : result.status === 'cancelled' ? 130 : 1;
    }
    if (!screen) {
      if (args.no_banner) console.log(`EdaCode ${VERSION} | ${config.provider}/${config.model || (config.provider === 'mock' ? 'mock' : '未配置')} | ${config.mode}\n工作区：${safeTerminal(config.workspace)}\n会话：${store.id}\n/help 查看命令；/quit 退出。`);
      else console.log(welcome(config, engine.tools, p, undefined, TIPS[Math.floor(Math.random() * TIPS.length)]));
    }
    if (!modelReady(config)) terminal.display('info', config.api_key.trim() ? '尚未选择模型，输入 /model 获取可用模型并选择。' : '尚未连接模型，输入 /connect 配置 API key、Base URL 和模型。');
    let pending = args.query.join(' ').trim(); busy = false;
    while (true) {
      let text = pending || await input.read(promptText(p, config.mode)); pending = '';
      if (text === undefined) break; text = text.trim();
      while (text.endsWith('\\')) { const next = await input.read(`${p.faint}… ${p.reset}`); if (next === undefined) { text = ''; break; } text = text.slice(0, -1) + '\n' + next.trim(); }
      if (['q', 'quit', 'exit', '/quit', '/exit'].includes(text.toLowerCase())) break;
      if (text) await submit(text);
    }
    return 0;
  } catch (error) {
    screen?.close();
    const reason = engine ? engine.errorText(error) : safeTerminal(String(error));
    if (args.json) console.log(JSON.stringify({status: 'error', reason})); else process.stderr.write('EdaCode 启动失败：' + safeTerminal(reason) + '\n');
    return startupController.signal.aborted ? 130 : 2;
  } finally {
    input.close(); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
    try { await engine?.close(); } finally { await store?.close(); }
  }
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => { process.stderr.write(safeTerminal(String(error)) + '\n'); process.exitCode = 2; });
}
