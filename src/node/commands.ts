import fs from 'node:fs';
import path from 'node:path';
import { findShell } from './processes.js';
import type { Tools } from './tools.js';
import { noop, type Display } from './types.js';
export interface CustomCommand { name?: string; source?: string; path?: string; body: string; description?: string; argument_hint?: string }
export function parseCommand(file: string): {meta: Record<string, string>; body: string} {
  const text = fs.readFileSync(file, 'utf8'); const meta: Record<string, string> = {}; let body = text;
  if (text.startsWith('---')) {
    const lines = text.split(/\r?\n/); const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
    if (end > 0) {
      for (const line of lines.slice(1, end)) { const i = line.indexOf(':'); if (i >= 0) meta[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, ''); }
      body = lines.slice(end + 1).join('\n');
    }
  }
  return {meta, body: body.trim()};
}
export function discoverCommands(root: string, home: string): Map<string, CustomCommand> {
  const commands = new Map<string, CustomCommand>();
  for (const [base, source] of [[path.join(home, 'commands'), 'user'], [path.join(root, '.edacode', 'commands'), 'project']]) {
    if (!fs.existsSync(base)) continue;
    const visit = (dir: string) => {
      for (const entry of fs.readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) visit(file);
        else if (entry.isFile() && file.endsWith('.md')) try {
          if (fs.statSync(file).size > 100000) continue;
          const {meta, body} = parseCommand(file); const name = path.relative(base, file).slice(0, -3).split(path.sep).join(':');
          commands.set(name, {name, source, path: file, body, description: meta.description || `自定义命令 ${name}`, argument_hint: meta['argument-hint'] || ''});
        } catch {}
      }
    };
    visit(base);
  }
  return commands;
}
export function positional(args: string): string[] {
  const parts: string[] = []; let word = '', quote = '', escaped = false, active = false;
  for (const char of args) {
    if (escaped) { word += char; escaped = false; active = true; }
    else if (char === '\\' && quote !== "'") { escaped = true; active = true; }
    else if (quote) { if (char === quote) quote = ''; else word += char; active = true; }
    else if (char === "'" || char === '"') { quote = char; active = true; }
    else if (/\s/u.test(char)) { if (active) { parts.push(word); word = ''; active = false; } }
    else { word += char; active = true; }
  }
  if (quote || escaped) return args.trim().split(/\s+/);
  if (active) parts.push(word); return parts;
}
const placeholder = () => /\$\{?(\d+|ARGUMENTS)\}?|\{\{args\}\}/gi;
export const hasPlaceholder = (text: string): boolean => placeholder().test(text);
export function shellQuote(value: string): string { return /^[a-zA-Z0-9_@%+=:,./-]+$/.test(value) ? value : "'" + value.replaceAll("'", "'\"'\"'") + "'"; }
export function substitute(text: string, args: string, shell = false): string {
  const parts = positional(args);
  if (shell && hasPlaceholder(text)) {
    if (text.includes('<<')) throw new Error('shell 模板参数不支持 heredoc；请使用独立参数');
    let cursor = 0, quote = '', escaped = false;
    for (const match of text.matchAll(placeholder())) {
      for (const char of text.slice(cursor, match.index)) {
        if (escaped) escaped = false;
        else if (char === '\\' && quote !== "'") escaped = true;
        else if (quote) { if (char === quote) quote = ''; }
        else if ("'\"`".includes(char)) quote = char;
      }
      if (quote || escaped) throw new Error('shell 模板占位符请放在引号外，EdaCode 会自动转义参数');
      cursor = match.index + match[0].length;
    }
  }
  return text.replace(placeholder(), (_, token) => {
    const value = !token || token.toLowerCase() === 'arguments' ? args : parts[Number(token) - 1] || '';
    return shell ? shellQuote(value) : value;
  });
}
export function blocks(text: string, marker: string): {start: number; end: number; inner: string; marker: string}[] {
  const spans = []; let index = 0;
  while ((index = text.indexOf(marker, index)) >= 0) {
    let depth = 1, cursor = index + 2;
    for (; cursor < text.length; cursor++) {
      if (text[cursor] === '{') depth++;
      else if (text[cursor] === '}' && --depth === 0) break;
    }
    if (cursor >= text.length) break;
    spans.push({start: index, end: cursor + 1, inner: text.slice(index + 2, cursor), marker}); index = cursor + 1;
  }
  return spans;
}
function listing(tools: Tools, value: string): string {
  const target = tools.path(value); const prefix = path.relative(tools.root, target).split(path.sep).join('/');
  const rows: string[] = [];
  for (const file of tools.files()) if (!prefix || file.startsWith(prefix + '/')) { rows.push(file); if (rows.length >= 500) break; }
  return `\n[目录 ${value} 共 ${rows.length} 项]\n` + rows.join('\n');
}
function fileBlock(value: string, tools: Tools): string {
  const target = value.trim();
  try { return fs.statSync(tools.path(target)).isDirectory() ? listing(tools, target) : `\n[文件 ${target}]\n` + tools.readText(target); }
  catch (error) { return `[@${target} 无法注入：${error}]`; }
}
async function shellBlock(command: string, tools: Tools, display: Display): Promise<string> {
  command = command.trim(); display('tool', '自定义命令注入 shell：' + command);
  const [output, error] = await tools.call('shell', {command});
  return `\n[命令 \`${command}\` 输出${error ? '[退出状态：失败]' : ''}]\n${output}`;
}
export function injectFiles(text: string, tools: Tools): string {
  for (const span of blocks(text, '@{').reverse()) text = text.slice(0, span.start) + fileBlock(span.inner, tools) + text.slice(span.end);
  return text;
}
export async function injectShell(text: string, tools: Tools, display: Display = noop): Promise<string> {
  const pieces: string[] = []; let cursor = 0;
  for (const span of blocks(text, '!{')) { pieces.push(text.slice(cursor, span.start), await shellBlock(span.inner, tools, display)); cursor = span.end; }
  return pieces.join('') + text.slice(cursor);
}
export function injectReferences(text: string, tools: Tools): string {
  return text.replace(/(?<![\p{L}\p{N}_@])@([^\s@]+)/gu, match => {
    const token = match.slice(1).replace(/[.,;:!?，。；：！？]+$/, ''); if (!token || token.startsWith('{')) return match;
    try { const target = tools.path(token); if (!fs.existsSync(target)) return match; return fileBlock(token, tools); } catch { return match; }
  });
}
export async function expand(command: CustomCommand, args: string, tools: Tools, display: Display = noop): Promise<string> {
  const text = command.body; const spans = [...blocks(text, '@{'), ...blocks(text, '!{')].sort((a, b) => a.start - b.start);
  let end = -1;
  for (const span of spans) { if (span.start < end) throw new Error('命令模板不支持嵌套的文件/shell 注入'); end = span.end; }
  const pieces: string[] = []; let cursor = 0;
  for (const span of spans) {
    pieces.push(substitute(text.slice(cursor, span.start), args));
    if (span.marker === '@{') pieces.push(fileBlock(substitute(span.inner, args), tools));
    else {
      if (hasPlaceholder(span.inner) && !findShell()) throw new Error('shell 模板参数转义需要 bash；请安装 Git Bash 或使用固定命令');
      pieces.push(await shellBlock(substitute(span.inner, args, true), tools, display));
    }
    cursor = span.end;
  }
  let result = pieces.join('') + substitute(text.slice(cursor), args);
  if (args.trim() && !hasPlaceholder(text)) result += '\n\n' + args;
  return result;
}
