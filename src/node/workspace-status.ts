import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface WorkspaceStatus {
  project: string;
  branch: string;
  git: 'loading' | 'clean' | 'modified' | 'unavailable';
  changes: number;
  files?: number;
  limited?: boolean;
}
const excluded = new Set(['.git', 'node_modules', '.edacode', '.venv', 'venv', '__pycache__']);
function git(workspace: string, args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['--no-optional-locks', '-C', workspace, ...args],
      {signal, timeout: 3000, maxBuffer: 2_000_000, windowsHide: true},
      (error, stdout) => error ? reject(error) : resolve(stdout.trimEnd()));
  });
}
/** 异步读取，只统计普通文件，不跟随符号链接；上限避免大型目录阻塞启动。 */
export async function inspectWorkspace(workspace: string, signal: AbortSignal, home?: string): Promise<WorkspaceStatus> {
  const result: WorkspaceStatus = {project: path.basename(workspace) || workspace, branch: '—', git: 'unavailable', changes: 0};
  const count = async () => {
    const queue = [workspace]; let files = 0, visited = 0;
    try {
      while (queue.length && files < 50_000 && visited < 5000) {
        signal.throwIfAborted(); const directory = queue.pop()!; visited++;
        for (const entry of await fs.readdir(directory, {withFileTypes: true})) {
          signal.throwIfAborted(); const target = path.join(directory, entry.name);
          if (excluded.has(entry.name) || target === home) continue;
          if (entry.isDirectory()) queue.push(target);
          else if (entry.isFile()) files++;
          if (files >= 50_000) break;
        }
      }
      result.files = files; result.limited = queue.length > 0 || files >= 50_000;
    } catch { /* 无权限或目录消失时显示未知，而不将部分统计当作完整结果。 */ }
  };
  await Promise.allSettled([count(), (async () => {
    const status = await git(workspace, ['status', '--porcelain=v1', '--untracked-files=normal'], signal);
    result.git = status ? 'modified' : 'clean'; result.changes = status ? status.split('\n').length : 0;
    try { result.branch = await git(workspace, ['symbolic-ref', '--short', 'HEAD'], signal); }
    catch { try { result.branch = (await git(workspace, ['rev-parse', '--short', 'HEAD'], signal)) + ' (detached)'; } catch {} }
  })()]);
  signal.throwIfAborted(); return result;
}
