import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import spawn from 'cross-spawn';
import type { ChildProcess } from 'node:child_process';
import { killTree } from './processes.js';
import { encode } from './storage.js';
import { cancelled, errorText, noop, type Display, type ToolSpec } from './types.js';
export const PROTOCOL_VERSION = '2024-11-05';
export function formatResult(result: any): string {
  if (!result || typeof result !== 'object') return JSON.stringify(result);
  return (result.content || []).map((item: any) => item?.type === 'text' ? String(item.text || '') : JSON.stringify(item)).join('\n') || JSON.stringify(result);
}
export function toolSpec(full: string, server: string, tool: any): ToolSpec {
  const schema = tool.inputSchema?.type === 'object' ? {...tool.inputSchema} : {type: 'object', properties: {}};
  if (!schema.properties || typeof schema.properties !== 'object') schema.properties = {};
  return {name: full, description: `[MCP ${server}] ${String(tool.description || '').trim() || '外部 MCP 工具'}`.slice(0, 1024), input_schema: schema};
}
export class MCPServer {
  process?: ChildProcess; tools: any[] = []; stderr = ''; private nextId = 0; private closed = false;
  private pending = new Map<number, {resolve: (value: any) => void; reject: (error: Error) => void}>();
  constructor(public name: string, public spec: any, public cwd: string, public timeout = 20) {}
  async start(signal?: AbortSignal): Promise<void> {
    cancelled(signal);
    if (typeof this.spec.command !== 'string' || !this.spec.command.trim()) throw new Error(`mcp server ${this.name} 缺少 command`);
    if (!Array.isArray(this.spec.args ?? [])) throw new Error(`mcp server ${this.name} 的 args 必须是数组`);
    const env = {...process.env}; for (const [k, v] of Object.entries(this.spec.env || {})) env[k] = String(v);
    const child = this.process = spawn(this.spec.command, (this.spec.args || []).map(String), {cwd: this.cwd, env,
      stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true});
    const lines = readline.createInterface({input: child.stdout!});
    lines.on('line', line => {
      let message: any; try { message = JSON.parse(line); } catch { return; }
      if (!message || typeof message !== 'object') return;
      // 外部 server 请求不自动执行客户端功能，也不能被误当作本地请求的响应。
      if (message.method) {
        if (message.id !== undefined) this.send({jsonrpc: '2.0', id: message.id, error: {code: -32601, message: 'Client method not supported'}});
        return;
      }
      const entry = this.pending.get(message.id); if (!entry) return;
      if (message.error) entry.reject(new Error(encode(message.error))); else entry.resolve(message.result);
    });
    child.stderr!.on('data', (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString('utf8')).slice(-8192); });
    const fail = (reason: string) => { for (const entry of this.pending.values()) entry.reject(new Error(`mcp server ${this.name} ${reason}；stderr: ${this.stderr.slice(-500)}`)); };
    child.on('error', error => fail(error.message)); child.on('exit', () => fail('已退出')); child.stdin!.on('error', error => fail(error.message));
    await this.request('initialize', {protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: {name: 'edacode', version: '0.2.0'}}, signal);
    this.send({jsonrpc: '2.0', method: 'notifications/initialized', params: {}});
    const result = await this.request('tools/list', {}, signal);
    if (!Array.isArray(result?.tools)) throw new Error('MCP tools/list 返回无效');
    this.tools = result.tools.filter((t: any) => typeof t.name === 'string' && t.name);
  }
  private send(message: any): void {
    if (!this.process?.stdin?.writable || this.closed) throw new Error(`mcp server ${this.name} 未运行`);
    this.process.stdin.write(JSON.stringify(message) + '\n');
  }
  async request(method: string, params: any, signal?: AbortSignal): Promise<any> {
    cancelled(signal);
    if (!this.process || this.closed || this.process.exitCode !== null || this.process.signalCode !== null) throw new Error(`mcp server ${this.name} 未运行`);
    const id = ++this.nextId;
    let timer: NodeJS.Timeout | undefined; let abort: (() => void) | undefined;
    try {
      return await new Promise((resolve, reject) => {
        this.pending.set(id, {resolve, reject});
        timer = setTimeout(() => reject(new Error(`mcp server ${this.name} 响应超时：${method}`)), this.timeout * 1000);
        abort = () => reject(signal?.reason || new Error('已中断')); signal?.addEventListener('abort', abort, {once: true});
        try { this.send({jsonrpc: '2.0', id, method, params}); } catch (error) { reject(error); }
      });
    } finally { clearTimeout(timer); this.pending.delete(id); if (abort) signal?.removeEventListener('abort', abort); }
  }
  async call(tool: string, args: any, signal?: AbortSignal): Promise<string> {
    const result = await this.request('tools/call', {name: tool, arguments: args}, signal);
    if (result?.isError === true) throw new Error(formatResult(result)); return formatResult(result);
  }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true;
    for (const entry of this.pending.values()) entry.reject(new Error('server 已退出')); this.pending.clear();
    if (!this.process) return;
    const child = this.process; const done = new Promise<void>(resolve => { if (!child.pid || child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('exit', () => resolve()); });
    await killTree(child); child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); await done;
  }
}
export class MCPManager {
  servers = new Map<string, MCPServer>(); definitions = new Map<string, ToolSpec>(); errors: string[] = [];
  private routes = new Map<string, [MCPServer, string]>();
  constructor(public root: string, public display: Display = noop, public timeout = 20, public authorizeStart?: (name: string, spec: any) => Promise<void>) {}
  readConfig(): any {
    for (const file of [path.join(this.root, 'mcp.json'), path.join(this.root, '.edacode', 'mcp.json')]) {
      if (!fs.existsSync(file)) continue;
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8')); const servers = data?.mcpServers ?? data;
        if (servers && typeof servers === 'object' && !Array.isArray(servers)) return servers;
        throw new Error('缺少 mcpServers 对象');
      } catch (error) { this.errors.push(`${path.basename(file)}: ${errorText(error)}`); }
    }
    return {};
  }
  async load(signal?: AbortSignal): Promise<this> {
    for (const [name, spec] of Object.entries(this.readConfig())) {
      cancelled(signal);
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) { this.errors.push(`${name}: 配置必须是对象`); continue; }
      const server = new MCPServer(name, spec, this.root, this.timeout);
      try { await this.authorizeStart?.(name, spec); await server.start(signal); }
      catch (error) { await server.close(); cancelled(signal); this.errors.push(`${name}: ${errorText(error)}`); this.display('info', `MCP server ${name} 不可用：${errorText(error)}`); continue; }
      this.servers.set(name, server);
      for (const tool of server.tools) {
        const full = `mcp__${name}__${tool.name}`; this.definitions.set(full, toolSpec(full, name, tool)); this.routes.set(full, [server, tool.name]);
      }
    }
    return this;
  }
  async call(full: string, args: any, signal?: AbortSignal): Promise<string> {
    const route = this.routes.get(full); if (!route) throw new Error('未知 MCP 工具：' + full); return route[0].call(route[1], args, signal);
  }
  async close(): Promise<void> { await Promise.all([...this.servers.values()].map(s => s.close())); this.servers.clear(); }
}
