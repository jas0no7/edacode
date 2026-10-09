import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import stringWidth from 'string-width';
import { FONT, TIPS } from './constants.js';
import type { Config } from './types.js';
import type { Tools } from './tools.js';
export const VERSION: string = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const MODE_LABELS: Record<string, string> = {plan: 'Plan', ask: 'Ask', edit: 'Edit', auto: 'Auto'};
const MODE_COLORS: Record<string, number> = {plan: 96, ask: 93, edit: 94, auto: 92};
export class Palette {
  reset: string; bold: string; dim: string; accent: string; text = ''; muted: string; faint: string; green: string; yellow: string; red: string;
  constructor(public enabled = true) {
    this.reset = this.s('0'); this.bold = this.s('1'); this.dim = this.s('2'); this.accent = this.s('94');
    this.muted = this.s('90'); this.faint = this.s('2;90'); this.green = this.s('92'); this.yellow = this.s('93'); this.red = this.s('91');
  }
  s(spec: string): string { return this.enabled ? `\x1b[${spec}m` : ''; }
  fg(level: number): string { return this.s(`38;5;${level}`); }
  mode(name: string): string { return this.s(String(MODE_COLORS[name] || 97)); }
  gradient(row: number, rows: number): string { return this.fg(240 + Math.round(15 * row / Math.max(rows - 1, 1))); }
}
export const PLAIN = new Palette(false);
export function supportsColor(stream: {isTTY?: boolean} = process.stdout): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  return !!stream.isTTY && process.env.TERM !== 'dumb';
}
export const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '');
export const visibleWidth = (text: string): number => stringWidth(text);
export const terminalWidth = (fallback = 88): number => Math.max(process.stdout.columns || fallback, 40);
export function logo(text = 'edacode'): string[] {
  return Array.from({length: 5}, (_, row) => [...text.toLowerCase()].map(char => ((FONT as Record<string, string[]>)[char] || FONT[' '])[row]).join('  '));
}
export function shortenHome(value: string): string { const home = os.homedir(); return value === home || value.startsWith(home + path.sep) ? '~' + value.slice(home.length) : value; }
export function statusBar(config: Config, tools: Tools, p: Palette, width = terminalWidth()): string {
  const count = tools.mcp?.servers.size || 0;
  const left = ` ${p.muted}${shortenHome(config.workspace)}${p.reset}  ${count ? p.green : p.faint}●${p.reset} ${p.faint}${count} MCP${p.reset}  ${p.faint}/status${p.reset}`;
  const right = `${p.faint}${VERSION}${p.reset} `; return left + ' '.repeat(Math.max(width - visibleWidth(left) - visibleWidth(right), 1)) + right;
}
export function welcome(config: Config, tools: Tools, p: Palette, width = terminalWidth(), tip: string = TIPS[0]): string {
  const art = logo(), pad = Math.max(Math.floor((width - visibleWidth(art[0])) / 2), 2); const out = [''];
  art.forEach((row, i) => out.push(' '.repeat(pad) + p.gradient(i, art.length) + row + p.reset)); out.push('');
  const content = Math.min(Math.max(width - 6, 40), 76), left = Math.max(Math.floor((width - content - 4) / 2), 2), margin = ' '.repeat(left);
  const bar = p.accent + '┃' + p.reset;
  out.push(margin + bar + '  ' + p.muted + '随便说点什么…  "修复 src 里的 TODO"' + p.reset);
  out.push(margin + bar + '  ' + p.mode(config.mode) + (MODE_LABELS[config.mode] || config.mode) + p.reset + '  ' + (config.model || (config.provider === 'mock' ? 'mock' : '未配置')) + '  ' + p.faint + config.provider + p.reset, '');
  const hints = p.faint + '/help 命令    /mode 切换权限    Ctrl-C 退出' + p.reset;
  out.push(' '.repeat(left + Math.max(content - visibleWidth(hints), 0)) + hints, '', margin + p.yellow + '●' + p.reset + ' ' + p.bold + 'Tip' + p.reset + ' ' + p.muted + tip + p.reset, '', statusBar(config, tools, p, width), '');
  return out.join('\n');
}
export function promptText(p: Palette, mode = 'edit'): string { return `\n${p.mode(mode)}${p.bold}❯${p.reset} `; }
export function safeTerminal(value: string): string {
  return String(value).replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}
