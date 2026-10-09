import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { uid } from './storage.js';
import { cancelled } from './types.js';
export function findShell(): string | undefined {
  if (process.platform !== 'win32') return '/bin/bash';
  const candidates = [process.env.EDACODE_SHELL, ...((process.env.PATH || '').split(path.delimiter).map(p => path.join(p, 'bash.exe'))),
    'C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'];
  return candidates.find(p => p && fs.existsSync(p));
}
export function shellArgv(command: string): {command: string; args: string[]} {
  const bash = findShell();
  return bash ? {command: bash, args: ['-lc', command]} : {command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command]};
}
export async function killTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    await new Promise<void>(resolve => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {stdio: 'ignore', windowsHide: true});
      killer.once('error', () => resolve()); killer.once('exit', () => resolve());
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error: any) { if (error.code !== 'ESRCH') throw error; }
  }
}
export class Job {
  id = 'job_' + uid(12); started = performance.now(); status = 'running'; exit_code: number | null = null;
  process: ChildProcess; output: Buffer[] = []; size = 0; truncated = false; done: Promise<void>;
  private timer?: NodeJS.Timeout; private cleaned = false; private stopPromise?: Promise<void>;
  constructor(public command: string, public cwd: string, public timeout: number) {
    const shell = shellArgv(command);
    this.process = spawn(shell.command, shell.args, {cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true});
    const read = (data: Buffer) => { const remaining = 2_000_000 - this.size; const portion = data.subarray(0, Math.max(0, remaining));
      this.output.push(portion); this.size += portion.length; this.truncated ||= data.length > remaining; };
    this.process.stdout!.on('data', read); this.process.stderr!.on('data', read);
    this.done = new Promise(resolve => {
      this.process.once('error', error => { read(Buffer.from(String(error))); this.status = 'failed'; clearTimeout(this.timer); });
      this.process.once('exit', (code, signal) => {
        this.exit_code = code ?? (signal ? -1 : null);
        if (this.status === 'running') this.status = code === 0 ? 'completed' : 'failed';
        clearTimeout(this.timer); void this.cleanup();
      });
      this.process.once('close', () => { clearTimeout(this.timer); resolve(); });
    });
    this.timer = setTimeout(() => { void this.stop('timeout'); }, timeout * 1000);
  }
  private async cleanup(): Promise<void> { if (!this.cleaned) { this.cleaned = true; await killTree(this.process); } }
  poll(): any {
    const output = Buffer.concat(this.output).toString('utf8') + (this.truncated ? '\n[输出超过 2 MB，后续内容丢弃；请缩小命令输出范围]' : '');
    return {job_id: this.id, status: this.status, exit_code: this.exit_code, command: this.command, output};
  }
  async stop(status = 'cancelled'): Promise<any> {
    if (!this.stopPromise) this.stopPromise = (async () => {
      if (this.status === 'running') { this.status = status; clearTimeout(this.timer); await this.cleanup(); }
      await this.done;
    })();
    await this.stopPromise; return this.poll();
  }
}
export class Processes {
  jobs = new Map<string, Job>(); private closed = false;
  constructor(public cwd: string) {}
  start(command: string, timeout = 120): Job {
    if (!command?.trim()) throw new Error('command 必须是非空字符串');
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 1800) throw new Error('timeout 必须在 0 到 1800 秒之间');
    if (this.closed) throw new Error('命令管理器已关闭');
    if ([...this.jobs.values()].filter(j => j.status === 'running').length >= 4) throw new Error('最多同时运行 4 个命令');
    const job = new Job(command, this.cwd, timeout); this.jobs.set(job.id, job); return job;
  }
  async run(command: string, timeout = 120, signal?: AbortSignal): Promise<any> {
    cancelled(signal); const job = this.start(command, timeout); const abort = () => { void job.stop(); };
    signal?.addEventListener('abort', abort, {once: true});
    try { await job.done; cancelled(signal); return job.poll(); }
    finally { signal?.removeEventListener('abort', abort); }
  }
  get(id: string): Job { const job = this.jobs.get(id); if (!job) throw new Error('未知 job ID；进程不会在重启后恢复'); return job; }
  async status(id: string, wait = 0, signal?: AbortSignal): Promise<any> {
    const job = this.get(id); const deadline = performance.now() + wait * 1000;
    while (job.status === 'running' && performance.now() < deadline) { cancelled(signal); await delay(50, undefined, {signal}); }
    return job.poll();
  }
  async close(): Promise<void> { this.closed = true; await Promise.all([...this.jobs.values()].map(j => j.stop())); }
}
