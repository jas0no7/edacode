import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { parseTree, findNodeAtLocation, type Node as JsonNode, type ParseError } from 'jsonc-parser';
import type { Config, Message } from './types.js';
export const CHECKPOINT_KEEP = 30;
export const encode = (value: any): string => JSON.stringify(value, null, 2);
export const digest = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
export const now = (): number => Date.now() / 1000;
export const uid = (length = 32): string => randomUUID().replaceAll('-', '').slice(0, length);
export function timestamp(): string {
  const d = new Date(); const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
export function atomicWrite(target: string, data: string | Buffer, mode = 0o600): void {
  fs.mkdirSync(path.dirname(target), {recursive: true, mode: 0o700});
  const temp = path.join(path.dirname(target), `.edacode-${uid()}`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, 'wx', mode); fs.writeFileSync(fd, data); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    if (process.platform === 'win32' && fs.existsSync(target)) fs.chmodSync(target, 0o600);
    fs.renameSync(temp, target);
  } finally { if (fd !== undefined) fs.closeSync(fd); fs.rmSync(temp, {force: true}); }
}
export const projectRoot = (config: Config): string => path.join(config.home, 'projects', digest(config.workspace).slice(0, 20));
export function listSessions(config: Config): any[] {
  const root = path.join(projectRoot(config), 'sessions'); const rows: any[] = [];
  if (!fs.existsSync(root)) return rows;
  for (const entry of fs.readdirSync(root, {withFileTypes: true})) {
    if (!entry.isDirectory()) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(root, entry.name, 'session.json'), 'utf8'));
      if (data.kind !== 'subagent' && typeof data.id === 'string' && typeof data.updated === 'number') rows.push({id: data.id, updated: data.updated, title: data.title || ''});
    } catch { /* 损坏的快照不影响其他会话的列举。 */ }
  }
  return rows.sort((a, b) => b.updated - a.updated);
}
/** 从原始 JSON 树重排缩进，保留 Python 写出的 1.0、-0.0、指数及键顺序。
 * 直接 JSON.parse 后计算旧摘要会丢失这些信息，误拒绝有效的旧检查点。
 */
export function legacyEncode(node: JsonNode, source: string, depth = 0): string {
  const pad = '  '.repeat(depth), next = pad + '  ';
  if (node.type === 'array') {
    const children = node.children || [];
    return children.length ? '[\n' + children.map(child => next + legacyEncode(child, source, depth + 1)).join(',\n') + '\n' + pad + ']' : '[]';
  }
  if (node.type === 'object') {
    const children = node.children || [];
    return children.length ? '{\n' + children.map(prop => {
      const [key, value] = prop.children!;
      return next + source.slice(key.offset, key.offset + key.length) + ': ' + legacyEncode(value, source, depth + 1);
    }).join(',\n') + '\n' + pad + '}' : '{}';
  }
  return source.slice(node.offset, node.offset + node.length);
}
function validateLegacyNumbers(node: JsonNode, source: string): void {
  if (node.type === 'number' && /^-?\d+$/.test(source.slice(node.offset, node.offset + node.length)) && !Number.isSafeInteger(node.value)) {
    throw new Error('旧会话含超出 JavaScript 安全整数范围的数值，已保留原数据，不能自动迁移');
  }
  for (const child of node.children || []) validateLegacyNumbers(child, source);
}
export class Store {
  id: string; project: string; root: string; path: string; data: any;
  private release?: () => Promise<void>;
  private pending: any;
  private compromised = false;
  private constructor(public config: Config, resume?: string) {
    if (resume === 'latest') { const rows = listSessions(config); if (!rows.length) throw new Error('当前工作区没有可以恢复的会话'); resume = rows[0].id; }
    this.project = projectRoot(config); this.id = resume || `${timestamp()}-${uid(8)}`;
    if (!/^\d{8}-\d{6}-[a-f0-9]{8}$/.test(this.id)) throw new Error('无效 session ID');
    this.root = path.join(this.project, 'sessions', this.id); this.path = path.join(this.root, 'session.json');
    if (resume && !fs.existsSync(this.path)) throw new Error(`会话不存在：${this.id}`);
    fs.mkdirSync(this.root, {recursive: true, mode: 0o700});
  }
  static async open(config: Config, resume?: string): Promise<Store> {
    const store = new Store(config, resume);
    try {
      store.release = await lockfile.lock(store.root, {lockfilePath: path.join(store.root, '.node.lock'), retries: 0, stale: 30000, update: 5000,
        onCompromised: () => { store.compromised = true; }});
    } catch { throw new Error('会话已在另一进程打开或无法为会话加锁'); }
    try {
      if (resume) {
        const source = fs.readFileSync(store.path, 'utf8'); store.data = JSON.parse(source);
        if (![1, 2].includes(store.data.version) || store.data.workspace !== config.workspace) throw new Error('会话版本或工作区不匹配');
        if (store.data.version === 1) store.migrate(source);
        store.repairPending();
      } else store.data = {version: 2, id: store.id, workspace: config.workspace, title: '', messages: [], todos: [], goal: null,
        usage: {input: 0, output: 0}, changes: [], generation: 0, checkpoints: [], updated: now()};
      store.save(); return store;
    } catch (error) { await store.close(); throw error; }
  }
  private migrate(source: string): void {
    const errors: ParseError[] = []; const tree = parseTree(source, errors, {disallowComments: true, allowTrailingComma: false});
    if (!tree || errors.length) throw new Error('旧会话 JSON 无效，未迁移');
    validateLegacyNumbers(tree, source);
    // 首次复制完整目录；意外退出后仍使用同一份备份重试迁移。
    const backup = path.join(this.root, 'legacy-v1-backup');
    if (!fs.existsSync(backup)) {
      const temp = path.join(this.root, `.legacy-backup-${uid(8)}`); fs.mkdirSync(temp, {mode: 0o700});
      try {
        for (const entry of fs.readdirSync(this.root)) {
          if (entry === '.node.lock' || entry.startsWith('.legacy-backup-') || entry === 'legacy-v1-backup') continue;
          fs.cpSync(path.join(this.root, entry), path.join(temp, entry), {recursive: true, dereference: false});
        }
        fs.renameSync(temp, backup);
      } finally { fs.rmSync(temp, {recursive: true, force: true}); }
    }
    const original = fs.readFileSync(path.join(backup, 'session.json'), 'utf8');
    const originalTree = parseTree(original)!; const messagesNode = findNodeAtLocation(originalTree, ['messages']);
    const messages = JSON.parse(original).messages as Message[];
    for (const item of this.data.checkpoints || []) {
      const file = path.join(this.root, 'checkpoints', `${item.id}.json`);
      if (!/^\d{8}-\d{6}-[a-f0-9]{6}$/.test(item.id)) throw new Error('旧检查点 ID 无效');
      let checkpoint: any;
      try {
        checkpoint = JSON.parse(fs.readFileSync(path.join(backup, 'checkpoints', `${item.id}.json`), 'utf8'));
        const prefix = {...messagesNode!, children: messagesNode?.children?.slice(0, checkpoint.messages_len)};
        const verified = messagesNode && Number.isSafeInteger(checkpoint.messages_len) && checkpoint.messages_len >= 0 && checkpoint.messages_len <= messages.length
          && checkpoint.generation === this.data.generation && checkpoint.messages_digest
          && digest(legacyEncode(prefix, original)) === checkpoint.messages_digest;
        if (verified) checkpoint.messages_digest = digest(encode(messages.slice(0, checkpoint.messages_len)));
        else checkpoint.migration_error = '旧检查点哈希或对话分支无法验证，拒绝恢复';
      } catch { checkpoint = {...item, migration_error: '旧检查点文件无法验证，拒绝恢复'}; }
      checkpoint.digest_format = 'node-json-v1'; atomicWrite(file, encode(checkpoint));
    }
    this.data.version = 2; this.data.migrated_from = 1;
    this.data.migration_backup = 'legacy-v1-backup'; this.event('session_migrated', {from: 1});
  }
  save(): void {
    if (this.compromised || !this.release) throw new Error('会话锁已丢失，停止写入以免覆盖其他进程');
    this.data.updated = now(); atomicWrite(this.path, encode(this.data));
  }
  event(kind: string, data: Record<string, any> = {}): void {
    if (this.compromised || !this.release) throw new Error('会话锁已丢失');
    const file = path.join(this.root, 'events.jsonl'); const fd = fs.openSync(file, 'a', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({time: now(), type: kind, ...data}) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  beginCheckpoint(): void {
    this.pending = {time: now(), generation: this.data.generation || 0, messages_len: this.data.messages.length,
      messages_digest: digest(encode(this.data.messages)), digest_format: 'node-json-v1', todos: structuredClone(this.data.todos),
      goal: structuredClone(this.data.goal), changes_len: this.data.changes.length};
  }
  commitCheckpoint(label = '', kind = 'auto'): string | undefined {
    if (!this.pending) return;
    const entry = {id: `${timestamp()}-${uid(6)}`, label: label || (kind === 'auto' ? '自动' : '手动'), kind, ...this.pending}; this.pending = undefined;
    atomicWrite(path.join(this.root, 'checkpoints', `${entry.id}.json`), encode(entry));
    this.data.checkpoints ??= []; this.data.checkpoints.push(Object.fromEntries(['id', 'time', 'label', 'kind', 'messages_len', 'changes_len'].map(k => [k, entry[k]])));
    const drop = this.data.checkpoints.filter((e: any) => e.kind === 'auto').slice(0, Math.max(0, this.data.checkpoints.length - CHECKPOINT_KEEP));
    this.data.checkpoints = this.data.checkpoints.filter((e: any) => !drop.some((d: any) => d.id === e.id));
    for (const entry of drop) fs.rmSync(path.join(this.root, 'checkpoints', `${entry.id}.json`), {force: true});
    this.save(); return entry.id;
  }
  makeCheckpoint(label = ''): string { this.beginCheckpoint(); return this.commitCheckpoint(label, 'manual')!; }
  latestCheckpoint(): string | undefined { return this.data.checkpoints?.at(-1)?.id; }
  checkpoint(id: string): any {
    if (!this.data.checkpoints?.some((e: any) => e.id === id)) throw new Error('未知检查点：' + id);
    const entry = JSON.parse(fs.readFileSync(path.join(this.root, 'checkpoints', `${id}.json`), 'utf8'));
    if (entry.migration_error) throw new Error(entry.migration_error);
    return entry;
  }
  repairPending(): void {
    const messages = this.data.messages as Message[]; const index = messages.findLastIndex(m => m.role === 'assistant');
    if (index < 0) return;
    const done = new Set(messages.slice(index + 1).filter(m => m.role === 'tool').map(m => m.tool_call_id));
    for (const call of messages[index].tool_calls || []) if (!done.has(call.id)) messages.push({role: 'tool', tool_call_id: call.id, is_error: true,
      content: '运行被中断，执行状态未知；禁止盲目重放，请先检查实际文件/进程状态。'});
  }
  artifact(content: string, prefix = 'output'): string {
    if (!/^[a-z]+$/.test(prefix)) throw new Error('无效 artifact 前缀');
    const name = `${prefix}-${uid()}.txt`; atomicWrite(path.join(this.root, 'artifacts', name), content); return name;
  }
  readArtifact(id: string, offset = 0, limit = 12000): string {
    if (!/^[a-z]+-[a-f0-9]{32}\.txt$/.test(id)) throw new Error('无效 artifact ID');
    const data = Array.from(fs.readFileSync(path.join(this.root, 'artifacts', id), 'utf8'));
    return data.slice(offset, offset + limit).join('') + `\n[字符 ${offset}:${Math.min(offset + limit, data.length)} / ${data.length}]`;
  }
  async close(): Promise<void> { const release = this.release; this.release = undefined; if (release) await release().catch(() => {}); }
}
