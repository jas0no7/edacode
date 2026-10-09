import fs from 'node:fs';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { atomicWrite, digest, encode, Store } from './storage.js';
import { realPath } from './config.js';
import { Processes } from './processes.js';
import { checkCommand, Policy } from './permissions.js';
import { MCPManager } from './mcp.js';
import { discoverCommands } from './commands.js';
import { DEFINITIONS } from './definitions.js';
import { cancelled, errorText, noop, type Config, type Display, type ToolSpec } from './types.js';
const LIMIT = 2_000_000;
export function inside(root: string, target: string): boolean { const rel = path.relative(root, target); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); }
export function globMatch(relative: string, pattern: string): boolean {
  let regex = '';
  for (let i = 0; i < pattern.length;) {
    const char = pattern[i];
    if (pattern.startsWith('**/', i)) { regex += '(?:[^/]+/)*'; i += 3; }
    else if (pattern.startsWith('**', i)) { regex += '.*'; i += 2; }
    else if (char === '*') { regex += '[^/]*'; i++; }
    else if (char === '?') { regex += '[^/]'; i++; }
    else if (char === '[' && pattern.indexOf(']', i + 1) > i) { const end = pattern.indexOf(']', i + 1); regex += pattern.slice(i, end + 1); i = end + 1; }
    else { regex += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); i++; }
  }
  return new RegExp('^' + regex + '$', 'u').test(relative);
}
function ignoreMatch(relative: string, pattern: string): boolean {
  const p = pattern.replace(/\/$/, ''); return relative.startsWith(p + '/') || globMatch(relative, pattern.replaceAll('*', '**'));
}
export function validate(value: any, schema: any, label = 'args'): void {
  const kind = schema.type;
  const good = kind === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
    : kind === 'array' ? Array.isArray(value) : kind === 'integer' ? Number.isSafeInteger(value)
    : kind === 'number' ? typeof value === 'number' && Number.isFinite(value) : kind === 'string' || kind === 'boolean' ? typeof value === kind : true;
  if (!good) throw new Error(`${label} 必须为 ${kind}`);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${label} 不在允许值中`);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties || {};
    if ((schema.required || []).some((k: string) => !Object.hasOwn(value, k))) throw new Error(`${label} 缺少必填参数`);
    if (schema.additionalProperties === false && Object.keys(value).some(k => !Object.hasOwn(properties, k))) throw new Error(`${label} 含未知参数`);
    for (const [key, item] of Object.entries(value)) if (Object.hasOwn(properties, key)) validate(item, properties[key], `${label}.${key}`);
  }
  if (Array.isArray(value)) {
    if (value.length < (schema.minItems || 0) || value.length > (schema.maxItems ?? 1000000)) throw new Error(`${label} 数量越界`);
    for (const item of value) validate(item, schema.items || {}, label + '[]');
  }
  if (typeof value === 'string' && Array.from(value).length < (schema.minLength || 0)) throw new Error(`${label} 不能为空`);
  if (typeof value === 'number' && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) throw new Error(`${label} 数值越界`);
}
export class Tools {
  root: string; protected: string; seen = new Map<string, string>(); readSeen = new Set<string>();
  processes?: Processes; mcp?: MCPManager; definitions = new Map<string, ToolSpec>(); skills = new Map<string, any>();
  commands: Map<string, any>; delegateHandler?: (tasks: string[]) => Promise<string>; signal?: AbortSignal; mcpNeedsRestart = false;
  constructor(public config: Config, public store: Store, public policy: Policy, public display: Display = noop, public readonly = false) {
    this.root = config.workspace; this.protected = realPath(config.home);
    if (!readonly) this.processes = new Processes(this.root);
    this.discoverSkills(); this.commands = discoverCommands(this.root, config.home);
    for (const item of DEFINITIONS) if (!readonly || ['read_file', 'list_files', 'search', 'load_skill', 'read_artifact'].includes(item.name)) this.definitions.set(item.name, item);
  }
  async initialize(signal?: AbortSignal): Promise<void> {
    this.signal = signal;
    if (this.readonly) return;
    for (const name of this.mcp?.definitions.keys() || []) this.definitions.delete(name);
    await this.mcp?.close();
    this.mcpNeedsRestart = false;
    this.mcp = new MCPManager(this.root, this.display, 20, (name, spec) => this.policy.authorize('mcp_start', encode({server: name, command: spec.command, args: spec.args || []})));
    await this.mcp.load(signal);
    for (const [name, definition] of this.mcp.definitions) this.definitions.set(name, definition);
  }
  path(value: string): string {
    if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('无效文件路径');
    const target = realPath(path.resolve(this.root, value));
    if (!inside(this.root, target) || inside(this.protected, target) || path.relative(this.root, target).split(path.sep).includes('.git')) {
      throw new Error('路径必须位于工作区内，且不能访问 .git 内部或状态目录');
    }
    return target;
  }
  discoverSkills(): void {
    for (const root of [path.join(this.root, 'skills'), path.join(this.root, '.edacode', 'skills')]) {
      if (!fs.existsSync(root)) continue;
      for (const name of fs.readdirSync(root).sort()) {
        try {
          const file = this.path(path.join(root, name, 'SKILL.md')); if (fs.statSync(file).size > 100000) continue;
          const text = this.bytes(file).toString('utf8'); const match = text.match(/^description:\s*(.*)$/m);
          this.skills.set(name, {path: file, description: (match?.[1]?.replace(/^["']|["']$/g, '') || '按需读取此技能').slice(0, 240)});
        } catch { /* 不载入越界或非文本技能。 */ }
      }
    }
  }
  specs(): ToolSpec[] { return [...this.definitions.values()]; }
  async call(name: string, args: any): Promise<[string, boolean]> {
    try {
      cancelled(this.signal);
      const definition = this.definitions.get(name); if (!definition) throw new Error(`未知或当前角色禁用的工具：${name}`);
      if (typeof args === 'string') args = JSON.parse(args);
      validate(args, definition.input_schema);
      if (name === 'shell') checkCommand(args.command);
      this.display('tool', name + ' ' + JSON.stringify(Object.fromEntries(Object.entries(args).filter(([k]) => !['content', 'old_text', 'new_text'].includes(k)))).slice(0, 600));
      if (!['write_file', 'edit_file'].includes(name)) await this.policy.authorize(name, encode(args));
      cancelled(this.signal);
      const handler = (this as any)[name];
      const output = this.mcp?.definitions.has(name) ? await this.mcp.call(name, args, this.signal) : await handler.call(this, args);
      let text = typeof output === 'string' ? output : encode(output);
      if (text.length > 16000) { const artifact = this.store.artifact(text); text = text.slice(0, 12000) + `\n[结果较长，完整输出使用 read_artifact：${artifact}]`; }
      const failed = ['shell', 'job_status'].includes(name) && ['failed', 'timeout', 'cancelled'].includes(output?.status);
      return [text, failed];
    } catch (error) { cancelled(this.signal); return [errorText(error), true]; }
  }
  bytes(target: string): Buffer {
    if (!fs.statSync(target).isFile() || fs.statSync(target).size > LIMIT) throw new Error('只支持不超过 2 MB 的普通 UTF-8 文件');
    const fd = fs.openSync(target, 'r'); const buffer = Buffer.alloc(LIMIT + 1); let size = 0;
    try { while (size <= LIMIT) { const count = fs.readSync(fd, buffer, size, buffer.length - size, null); if (!count) break; size += count; } }
    finally { fs.closeSync(fd); }
    if (size > LIMIT) throw new Error('读取过程中文件增长超过 2 MB');
    const data = buffer.subarray(0, size); if (data.includes(0)) throw new Error('不支持二进制文件');
    new TextDecoder('utf-8', {fatal: true}).decode(data); return data;
  }
  instructions(target: string): string {
    const dirs: string[] = []; let parent = path.dirname(target);
    while (inside(this.root, parent) && parent !== this.root) { dirs.unshift(parent); parent = path.dirname(parent); }
    let text = '';
    for (const dir of dirs) try {
      const file = this.path(path.join(dir, 'AGENTS.md'));
      if (fs.existsSync(file)) text += `\n[目录规范 ${path.relative(this.root, file)}]\n` + this.bytes(file).toString('utf8').slice(0, 12000);
    } catch {}
    return text.slice(0, 20000);
  }
  read_file({path: value, offset = 1, limit = 300}: any): string {
    const target = this.path(value), data = this.bytes(target); this.seen.set(target, digest(data)); this.readSeen.add(target);
    const lines = data.toString('utf8').split(/\r\n|[\n\r\v\f\x85\u2028\u2029]/); if (lines.at(-1) === '') lines.pop();
    return `${value} | sha256=${digest(data)} | 共 ${lines.length} 行\n` + lines.slice(offset - 1, offset - 1 + limit).map((line, i) => `${String(i + offset).padStart(5)} | ${line}`).join('\n') + this.instructions(target);
  }
  *files(pattern = '**/*'): Generator<string> {
    const skipped = new Set(['.git', '.venv', 'venv', 'node_modules', '__pycache__', '.idea', '.edacode', 'dist', 'build', '.pytest_cache']);
    let ignored: string[] = []; try { ignored = this.bytes(this.path('.edacodeignore')).toString('utf8').split(/\r?\n/).map(x => x.trim()).filter(x => x && !x.startsWith('#')); } catch {}
    const queue = [this.root]; let count = 0;
    while (queue.length) {
      const dir = queue.pop()!; const dirs: string[] = [];
      for (const entry of fs.readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name < b.name ? -1 : 1)) {
        const file = path.join(dir, entry.name); const rel = path.relative(this.root, file).split(path.sep).join('/');
        if (entry.isDirectory()) { if (!skipped.has(entry.name) && !inside(this.protected, realPath(file))) dirs.push(file); continue; }
        if (entry.name === '.env' || (entry.name.startsWith('.env.') && !/example$|sample$/.test(entry.name))) continue;
        if (ignored.some(p => ignoreMatch(rel, p)) || !globMatch(rel, pattern)) continue;
        try { if (!fs.statSync(this.path(rel)).isFile()) continue; } catch { continue; }
        yield rel; if (++count >= 10000) return;
      }
      queue.push(...dirs.reverse());
    }
  }
  list_files({pattern = '**/*'}: any = {}): string {
    const rows: string[] = []; for (const file of this.files(pattern)) { rows.push(file); if (rows.length > 500) break; }
    return rows.slice(0, 500).join('\n') + (rows.length > 500 ? '\n[至少还有一项，请缩小 pattern]' : '') || '没有匹配文件';
  }
  search({text, pattern = '**/*', case_sensitive = true}: any): string {
    const rows: string[] = []; const needle = case_sensitive ? text : text.toLowerCase();
    for (const rel of this.files(pattern)) {
      let body: string; try { body = this.bytes(this.path(rel)).toString('utf8'); } catch { continue; }
      for (const [i, line] of body.split(/\r?\n/).entries()) if ((case_sensitive ? line : line.toLowerCase()).includes(needle)) {
        rows.push(`${rel}:${i + 1}: ${line.slice(0, 500)}`); if (rows.length >= 200) return rows.join('\n') + '\n[已达 200 项，请缩小范围]';
      }
    }
    return rows.join('\n') || '没有匹配内容';
  }
  private async change(value: string, content: string, expected?: Buffer): Promise<string> {
    if (this.readonly) throw new Error('只读子 agent 不允许修改');
    cancelled(this.signal);
    const target = this.path(value); if (target === this.root) throw new Error('不能替换工作目录');
    const old = fs.existsSync(target) ? this.bytes(target) : null;
    if (expected && !old?.equals(expected)) throw new Error('计算替换内容期间文件发生变化，请重新读取');
    if (old && (this.seen.get(target) !== digest(old) || !this.readSeen.has(target))) throw new Error('文件未读取或在读取后已变化；请重新 read_file 后编辑');
    const data = Buffer.from(content, 'utf8'); if (data.length > LIMIT) throw new Error('单次写入不能超过 2 MB');
    if (old?.equals(data)) return '内容未变化';
    const diff = createTwoFilesPatch(old ? value : '/dev/null', value, old?.toString('utf8') || '', content);
    this.display('diff', diff); await this.policy.authorize('write_file', diff); cancelled(this.signal);
    const current = fs.existsSync(target) ? this.bytes(target) : null;
    if (this.path(value) !== target || (old === null ? current !== null : !current?.equals(old))) throw new Error('审批期间文件发生变化，已取消本次写入');
    const mode = old ? fs.statSync(target).mode & 0o777 : 0o644;
    const record: any = {path: path.relative(this.root, target).split(path.sep).join('/'), before: old?.toString('base64') ?? null, after: digest(data), mode, undone: false, status: 'prepared', diff};
    this.store.data.changes.push(record); this.store.save(); this.store.commitCheckpoint(record.path);
    try { atomicWrite(target, data, mode); }
    catch (error) { if (!fs.existsSync(target) || digest(fs.readFileSync(target)) !== record.after) { record.status = 'failed'; this.store.save(); } throw error; }
    record.status = 'applied'; this.store.save(); this.seen.set(target, digest(data)); this.readSeen.delete(target);
    return `已修改 ${value}，${data.length} 字节\n${diff.slice(0, 10000)}`;
  }
  async write_file({path, content}: any): Promise<string> { return this.change(path, content); }
  async edit_file({path, old_text, new_text, all = false}: any): Promise<string> {
    const original = this.bytes(this.path(path)), text = original.toString('utf8');
    if (!old_text) throw new Error('old_text 不能为空');
    const count = text.split(old_text).length - 1;
    if (!count || (count > 1 && !all)) throw new Error(`原文匹配 ${count} 处；请提供唯一原文，或明确 all=true`);
    const next = all ? text.split(old_text).join(new_text) : text.replace(old_text, () => new_text);
    return this.change(path, next, original);
  }
  undo(): string {
    for (const change of [...this.store.data.changes].reverse()) {
      if (change.undone || change.status === 'failed') continue;
      const target = this.path(change.path);
      if (!fs.existsSync(target) || digest(fs.readFileSync(target)) !== change.after) throw new Error('文件在此变更后发生变化，拒绝覆盖；请手动检查 /diff');
      if (change.before === null) fs.unlinkSync(target); else atomicWrite(target, Buffer.from(change.before, 'base64'), change.mode);
      change.undone = true; this.seen.delete(target); this.readSeen.delete(target); this.store.save(); return '已撤销：' + change.path;
    }
    return '没有可撤销的专用工具文件修改';
  }
  restoreFiles(length: number): [string[], [string, string][]] {
    const reverted: string[] = [], skipped: [string, string][] = [];
    for (const change of this.store.data.changes.slice(length).reverse()) {
      if (change.undone || change.status === 'failed') continue;
      try {
        const target = this.path(change.path); const current = fs.existsSync(target) ? fs.readFileSync(target) : null;
        if (!current && change.before === null) { change.undone = true; continue; }
        if (!current || digest(current) !== change.after) { skipped.push([change.path, '内容在检查点后被外部修改']); continue; }
        if (change.before === null) fs.unlinkSync(target); else atomicWrite(target, Buffer.from(change.before, 'base64'), change.mode);
        change.undone = true; this.seen.delete(target); this.readSeen.delete(target); reverted.push(change.path);
      } catch (error) { skipped.push([change.path, '回滚失败：' + errorText(error)]); }
    }
    this.store.save(); return [reverted, skipped];
  }
  async shell({command, timeout = 120, background = false}: any): Promise<any> {
    if (!this.processes) throw new Error('当前角色不能运行 shell'); checkCommand(command);
    if (background) { const job = this.processes.start(command, timeout); return {job_id: job.id, status: 'running', note: '必须用 job_status 检查完成结果；重启不恢复进程'}; }
    return this.processes.run(command, timeout, this.signal);
  }
  async job_status({job_id, wait = 0}: any): Promise<any> { return this.processes!.status(job_id, wait, this.signal); }
  async cancel_job({job_id}: any): Promise<any> { return this.processes!.get(job_id).stop(); }
  update_plan({items}: any): any {
    if (items.filter((i: any) => i.status === 'in_progress').length > 1) throw new Error('只能有一个进行中的步骤');
    this.store.data.todos = items; this.store.save(); return items;
  }
  load_skill({name}: any): string { const skill = this.skills.get(name); if (!skill) throw new Error('未知技能：' + name); return this.bytes(this.path(skill.path)).toString('utf8'); }
  readText(value: string, limit = 100000): string { const data = this.bytes(this.path(value)).toString('utf8'); return data.length > limit ? data.slice(0, limit) + `\n[已截断，原文共 ${data.length} 字符]` : data; }
  read_artifact({artifact_id, offset = 0, limit = 12000}: any): string { return this.store.readArtifact(artifact_id, offset, limit); }
  async delegate({tasks}: any): Promise<string> { if (!this.delegateHandler) throw new Error('当前会话未启用子 agent'); return this.delegateHandler(tasks); }
  async cancelRunning(): Promise<void> {
    await Promise.all([...(this.processes?.jobs.values() || [])].filter(j => j.status === 'running').map(j => j.stop()));
    await this.mcp?.close();
    for (const name of this.mcp?.definitions.keys() || []) this.definitions.delete(name);
    this.mcpNeedsRestart = !this.readonly;
  }
  async close(): Promise<void> { await this.mcp?.close(); await this.processes?.close(); }
}
