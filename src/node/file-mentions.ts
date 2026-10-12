import fs from 'node:fs/promises';
import path from 'node:path';
import { DISCOVERY_SKIPPED, ignoreMatch, inside } from './tools.js';

export interface FileIndex { files: string[]; limited: boolean }
/** 异步发现工作区文件，不读取正文，也不跟随目录软链接。 */
export async function discoverMentionFiles(workspace: string, home: string | undefined, signal: AbortSignal): Promise<FileIndex> {
  signal.throwIfAborted();
  const root = await fs.realpath(workspace), protectedRoot = home ? await fs.realpath(home).catch(() => path.resolve(home)) : undefined;
  let ignored: string[] = [];
  const ignoreFile = path.join(root, '.edacodeignore');
  try {
    const stat = await fs.lstat(ignoreFile);
    if (stat.isFile() && stat.size <= 2_000_000) ignored = (await fs.readFile(ignoreFile, 'utf8')).split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  } catch { /* 没有忽略文件。 */ }
  const queue = [root], files: string[] = []; let visited = 0;
  while (queue.length && visited < 5000) {
    signal.throwIfAborted(); const directory = queue.pop()!; visited++;
    const real = await fs.realpath(directory).catch(() => '');
    if (!real || !inside(root, real) || (protectedRoot && inside(protectedRoot, real))) continue;
    const entries = await fs.readdir(directory, {withFileTypes: true}).catch(error => { if (directory === root) throw error; return []; });
    const dirs: string[] = [];
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : 1)) {
      signal.throwIfAborted();
      const target = path.join(directory, entry.name), relative = path.relative(root, target).split(path.sep).join('/');
      if (entry.name === '.git' || /[\x00-\x1f\x7f]/.test(relative) || ignored.some(pattern => ignoreMatch(relative, pattern))) continue;
      if (entry.isDirectory()) { if (!DISCOVERY_SKIPPED.has(entry.name)) dirs.push(target); continue; }
      if (entry.name === '.env' || (entry.name.startsWith('.env.') && !/example$|sample$/.test(entry.name))) continue;
      if (entry.isSymbolicLink()) {
        const resolved = await fs.realpath(target).catch(() => '');
        if (!resolved || !inside(root, resolved) || (protectedRoot && inside(protectedRoot, resolved)) || path.relative(root, resolved).split(path.sep).includes('.git')) continue;
        if (!(await fs.stat(target).catch(() => undefined))?.isFile()) continue;
      } else if (!entry.isFile()) continue;
      files.push(relative);
      if (files.length >= 10000) return {files, limited: true};
    }
    queue.push(...dirs.reverse());
  }
  return {files, limited: queue.length > 0};
}

/** 文件名优先，其次连续路径，最后匹配有序但不连续的字符。 */
export function fuzzyFiles(files: string[], query: string): string[] {
  const needle = query.toLowerCase().replaceAll('\\', '/');
  if (!needle) return files;
  const score = (file: string): number => {
    const text = file.toLowerCase(), basename = text.slice(text.lastIndexOf('/') + 1);
    if (basename === needle) return 0;
    if (basename.startsWith(needle)) return 10 + basename.length / 1000;
    if (text.includes(needle)) return 20 + text.indexOf(needle) / 1000;
    let cursor = 0, first = -1, last = 0;
    for (const char of needle) {
      const at = text.indexOf(char, cursor); if (at < 0) return Infinity;
      if (first < 0) first = at;
      last = at; cursor = at + char.length;
    }
    return 30 + (last - first) + text.length / 1000;
  };
  return files.map(file => ({file, score: score(file)})).filter(item => Number.isFinite(item.score))
    .sort((a, b) => a.score - b.score || a.file.localeCompare(b.file)).map(item => item.file);
}
export function fileReference(file: string): string {
  return '@' + (!/[\s@"{}\\]/.test(file) && !/[.,;:!?，。；：！？]$/.test(file) ? file : JSON.stringify(file));
}
