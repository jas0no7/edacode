import readline from 'node:readline';
import { HELP } from './constants.js';
import { logo, Palette, safeTerminal, shortenHome, VERSION, visibleWidth } from './ui.js';
import type { Config } from './types.js';
import type { Tools } from './tools.js';

export interface PromptInput {
  onInterrupt: () => void;
  read(prompt: string, signal?: AbortSignal, secret?: boolean): Promise<string | undefined>;
  close(): void;
}
type Entry = {kind: string; text: string; width?: number; lines?: string[]};
type Option = {value: string; label: string};
type Pending = {prompt: string; secret: boolean; main: boolean; models: boolean; resolve: (value: string | undefined) => void; reject: (error: unknown) => void};
const segmenter = new Intl.Segmenter(undefined, {granularity: 'grapheme'});
const chars = (text: string): string[] => [...segmenter.segment(text)].map(item => item.segment);
export function wrapText(text: string, width: number): string[] {
  width = Math.max(1, width);
  const lines: string[] = [];
  for (const source of safeTerminal(text).replaceAll('\t', '    ').split(/\r?\n/)) {
    let line = '', used = 0;
    for (const char of chars(source)) {
      const size = visibleWidth(char);
      if (size > width) continue;
      if (used + size > width) { lines.push(line); line = ''; used = 0; }
      line += char; used += size;
    }
    lines.push(line);
  }
  return lines;
}
/** 按显示单元绘制，避免中文、emoji 和终端自动换行破坏布局。 */
class Frame {
  cells: {char: string; style: string}[][];
  cursor?: {row: number; column: number};
  constructor(public width: number, public height: number, public base: string) {
    this.cells = Array.from({length: height}, () => Array.from({length: width}, () => ({char: ' ', style: base})));
  }
  text(row: number, column: number, text: string, style = this.base, limit = this.width - column): void {
    if (row < 0 || row >= this.height) return;
    let used = 0;
    for (const char of chars(safeTerminal(text).replaceAll('\t', '    ').split('\n')[0])) {
      const size = visibleWidth(char); if (!size) continue;
      if (used + size > limit || column + used + size > this.width) break;
      if (column + used >= 0) {
        this.cells[row][column + used] = {char, style};
        for (let j = 1; j < size; j++) this.cells[row][column + used + j] = {char: '', style};
      }
      used += size;
    }
  }
  fill(row: number, column: number, width: number, height: number, style: string): void {
    for (let y = row; y < row + height; y++) this.text(y, column, ' '.repeat(Math.max(0, width)), style, width);
  }
  plain(): string[] { return this.cells.map(row => row.map(cell => cell.char).join('')); }
  ansi(reset: string): string {
    let output = '\x1b[?25l';
    for (let y = 0; y < this.height; y++) {
      output += `\x1b[${y + 1};1H`; let style: string | undefined;
      for (const cell of this.cells[y]) {
        if (cell.style !== style) { output += reset + cell.style; style = cell.style; }
        output += cell.char;
      }
      output += reset + this.base + '\x1b[K';
    }
    output += reset;
    if (this.cursor) output += `\x1b[${this.cursor.row + 1};${this.cursor.column + 1}H\x1b[?25h`;
    return output;
  }
}

export class FullScreen implements PromptInput {
  onInterrupt: () => void = () => {};
  private config?: Config;
  private tools?: Tools;
  private session = '';
  private pending?: Pending;
  private buffer: string[] = [];
  private cursor = 0;
  private history: string[] = [];
  private historyIndex = 0;
  private draft = '';
  private entries: Entry[] = [];
  private streaming?: Entry;
  private home: boolean;
  private notice = '正在启动…';
  private details = '';
  private modelOptions: Option[] = [];
  private selected = -1;
  private commandMenu = false;
  private menuIndex = 0;
  private scroll = 0;
  private dialogScroll = 0;
  private pasting = false;
  private closed = false;
  private timer?: NodeJS.Timeout;
  private wasRaw: boolean;
  private commands = HELP.split('\n').map(line => ({value: line.match(/^(\/[^\s[<]+)/)?.[1] || '', label: line})).filter(item => item.value);
  private styles: {base: string; panel: string; text: string; muted: string; accent: string; selected: string; warning: string; error: string};
  constructor(private source: NodeJS.ReadStream = process.stdin, private target: NodeJS.WriteStream = process.stdout,
    private palette = new Palette(true), noBanner = false) {
    this.home = !noBanner; this.wasRaw = !!source.isRaw;
    const color = (spec: string) => palette.s(spec);
    this.styles = {base: color('48;5;16;38;5;252'), panel: color('48;5;235;38;5;252'), text: color('48;5;16;38;5;252'),
      muted: color('48;5;16;38;5;245'), accent: color('48;5;16;38;5;75'), selected: color('48;5;24;38;5;255'),
      warning: color('48;5;16;38;5;221'), error: color('48;5;16;38;5;203')};
    readline.emitKeypressEvents(source);
    source.on('keypress', this.keypress); source.on('end', this.end); target.on('resize', this.resize);
    process.on('exit', this.exit);
    source.setRawMode(true); source.resume();
    target.write('\x1b[?1049h\x1b[?2004h\x1b[2J\x1b[H'); this.draw();
  }
  setContext(config: Config, tools?: Tools, session = ''): void {
    this.config = config; this.tools = tools; this.session = session;
    this.notice = config.provider === 'mock' ? '离线演示 · /connect 连接模型' : !config.api_key ? '尚未连接模型 · 输入 /connect 开始配置'
      : !config.model ? '接口已配置 · 输入 /model 选择模型' : '输入任务开始 · /help 查看命令';
    this.schedule();
  }
  submitted(text: string): void {
    this.scroll = 0;
    if (text === '/clear') { this.home = true; this.entries = []; return; }
    if (/^\/(connect|model)(?:\s|$)/.test(text)) return;
    this.home = false; this.entries.push({kind: 'user', text}); this.schedule();
  }
  display = (kind: string, value: string): void => {
    if (this.closed) return;
    const text = safeTerminal(value);
    if (kind === 'stream') {
      if (!this.streaming) { this.streaming = {kind: 'assistant', text: ''}; this.entries.push(this.streaming); }
      this.streaming.text += text; this.streaming.lines = undefined;
    } else if (kind === 'stream_end') this.streaming = undefined;
    else {
      this.entries.push({kind, text});
      if (kind === 'info') {
        this.details = text;
        this.modelOptions = text.split('\n').flatMap(line => {
          const match = line.match(/^\s+(\d+)\. (.+)$/); return match ? [{value: match[1], label: match[2]}] : [];
        });
      }
      if (text) this.notice = text.split('\n')[0];
    }
    if (kind === 'thinking') this.notice = text;
    if (this.entries.length > 300) this.entries.splice(0, this.entries.length - 300);
    this.schedule();
  };
  approval(name: string, detail: string): void {
    this.details = `请求执行 ${safeTerminal(name)}\n\n${safeTerminal(detail)}`;
    this.dialogScroll = 0; this.schedule();
  }
  async read(prompt: string, signal?: AbortSignal, secret = false): Promise<string | undefined> {
    signal?.throwIfAborted(); if (this.closed) return;
    const label = safeTerminal(prompt).trim();
    this.buffer = []; this.cursor = 0; this.selected = -1; this.dialogScroll = 0;
    this.historyIndex = this.history.length; this.commandMenu = false;
    let abort: (() => void) | undefined;
    try {
      return await new Promise<string | undefined>((resolve, reject) => {
        this.pending = {prompt: label, secret, main: !label || label === '❯' || label === '…', models: label.includes('选择模型编号'), resolve, reject};
        abort = () => { this.pending = undefined; this.buffer = []; this.cursor = 0; this.commandMenu = false; reject(signal?.reason); this.schedule(); };
        signal?.addEventListener('abort', abort, {once: true}); this.draw();
      });
    } finally { if (abort) signal?.removeEventListener('abort', abort); }
  }
  private complete(value: string | undefined): void {
    const pending = this.pending; if (!pending) return;
    if (pending.main && value?.trim()) {
      if (this.history.at(-1) !== value) this.history.push(value);
      if (this.history.length > 100) this.history.shift();
    }
    this.pending = undefined; this.buffer = []; this.cursor = 0; this.commandMenu = false;
    pending.resolve(value); this.schedule();
  }
  private insert(value: string): void {
    const clean = safeTerminal(value).replaceAll('\r', '\n');
    const before = this.buffer.slice(0, this.cursor).join('') + clean;
    this.buffer = chars(before + this.buffer.slice(this.cursor).join('')); this.cursor = chars(before).length;
    this.selected = -1; this.menuIndex = 0;
  }
  private options(): Option[] {
    const filter = this.buffer.join('').toLowerCase();
    return this.modelOptions.filter(item => !filter || /^\d+$/.test(filter) || item.label.toLowerCase().includes(filter));
  }
  private commandOptions(): Option[] {
    const filter = this.buffer.join('').replace(/^\//, '').toLowerCase();
    return this.commands.filter(item => item.label.toLowerCase().includes(filter));
  }
  private keypress = (text: string | undefined, key: readline.Key): void => {
    if (this.closed) return;
    if (key.name === 'paste-start') { this.pasting = true; return; }
    if (key.name === 'paste-end') { this.pasting = false; this.schedule(); return; }
    if (this.pasting) { if (this.pending && text) this.insert(text); this.schedule(); return; }
    if (key.ctrl && key.name === 'c') { this.onInterrupt(); return; }
    if (key.ctrl && key.name === 'd') { this.onInterrupt(); this.close(); return; }
    if (key.name === 'pageup' || key.name === 'pagedown') {
      const amount = Math.max(1, (this.target.rows || 30) - 10) * (key.name === 'pageup' ? 1 : -1);
      if (this.pending && !this.pending.main && !this.pending.models) this.dialogScroll = Math.max(0, this.dialogScroll - amount);
      else this.scroll = Math.max(0, this.scroll + amount);
      this.schedule(); return;
    }
    if (key.ctrl && key.name === 'l') { this.draw(); return; }
    const pending = this.pending; if (!pending) return;
    if (key.ctrl && key.name === 'p' && pending.main) { this.commandMenu = !this.commandMenu; this.menuIndex = 0; this.schedule(); return; }
    if (key.name === 'escape') {
      if (this.commandMenu) this.commandMenu = false;
      else if (!pending.main) { this.complete(undefined); return; }
      else { this.buffer = []; this.cursor = 0; }
    } else if (key.name === 'return' || key.name === 'enter') {
      if (pending.main && (key.meta || key.shift)) this.insert('\n');
      else if (this.commandMenu) {
        const option = this.commandOptions()[this.menuIndex];
        if (option) { this.buffer = chars(option.value); this.cursor = this.buffer.length; }
        this.commandMenu = false;
      } else {
        const choice = pending.models && this.selected >= 0 ? this.options()[this.selected]?.value : undefined;
        this.complete(choice ?? this.buffer.join('')); return;
      }
    } else if (key.name === 'up' || key.name === 'down') {
      const direction = key.name === 'down' ? 1 : -1;
      if (this.commandMenu) {
        const count = this.commandOptions().length; this.menuIndex = count ? (this.menuIndex + direction + count) % count : 0;
      } else if (pending.models) {
        const count = this.options().length;
        if (count) this.selected = this.selected < 0 ? direction > 0 ? 0 : count - 1 : (this.selected + direction + count) % count;
      } else if (pending.main) {
        if (this.historyIndex === this.history.length) this.draft = this.buffer.join('');
        this.historyIndex = Math.max(0, Math.min(this.history.length, this.historyIndex + direction));
        this.buffer = chars(this.historyIndex === this.history.length ? this.draft : this.history[this.historyIndex]); this.cursor = this.buffer.length;
      }
    } else if (key.name === 'left') this.cursor = Math.max(0, this.cursor - 1);
    else if (key.name === 'right') this.cursor = Math.min(this.buffer.length, this.cursor + 1);
    else if (key.name === 'home' || (key.ctrl && key.name === 'a')) this.cursor = 0;
    else if (key.name === 'end' || (key.ctrl && key.name === 'e')) this.cursor = this.buffer.length;
    else if (key.name === 'backspace') { if (this.cursor) this.buffer.splice(--this.cursor, 1); }
    else if (key.name === 'delete') this.buffer.splice(this.cursor, 1);
    else if (key.ctrl && key.name === 'u') { this.buffer.splice(0, this.cursor); this.cursor = 0; }
    else if (key.ctrl && key.name === 'k') this.buffer.splice(this.cursor);
    else if (key.ctrl && key.name === 'w') {
      while (this.cursor && /\s/.test(this.buffer[this.cursor - 1])) this.buffer.splice(--this.cursor, 1);
      while (this.cursor && !/\s/.test(this.buffer[this.cursor - 1])) this.buffer.splice(--this.cursor, 1);
    } else if (key.name === 'tab' && pending.main) {
      const option = this.commands.find(item => item.value.startsWith(this.buffer.join('')));
      if (option && this.buffer[0] === '/') { this.buffer = chars(option.value); this.cursor = this.buffer.length; }
    } else if (!key.ctrl && !key.meta && text && !text.startsWith('\x1b')) this.insert(text);
    this.schedule();
  };
  private end = (): void => this.close();
  private exit = (): void => this.close();
  private resize = (): void => this.schedule();
  private schedule(): void {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.draw(); }, 24);
    this.timer.unref();
  }
  private inputLines(width: number, secret = false): {lines: string[]; row: number; column: number} {
    const text = secret ? '•'.repeat(this.buffer.length) : this.buffer.join('');
    const before = secret ? '•'.repeat(this.cursor) : this.buffer.slice(0, this.cursor).join('');
    const lines = wrapText(text, width), prefix = wrapText(before, width);
    let row = prefix.length - 1, column = visibleWidth(prefix.at(-1) || '');
    if (column === width) { row++; column = 0; if (row >= lines.length) lines.push(''); }
    return {lines, row, column};
  }
  private composer(frame: Frame, top: number, left: number, width: number, height: number): void {
    const s = this.styles, config = this.config;
    frame.fill(top, left, width, height, s.panel);
    for (let y = top; y < top + height; y++) frame.text(y, left, '┃', s.accent);
    const input = this.inputLines(Math.max(1, width - 6));
    const available = Math.max(1, height - 3), start = Math.max(0, input.row - available + 1);
    const focused = !!this.pending?.main && !this.commandMenu;
    if (!this.buffer.length) frame.text(top + 1, left + 3, focused ? '随便说点什么… “修复 src 里的 TODO”' : '正在处理… Ctrl-C 中断', this.palette.s('48;5;235;38;5;245'), width - 5);
    else input.lines.slice(start, start + available).forEach((line, i) => frame.text(top + 1 + i, left + 3, line, s.panel, width - 5));
    const model = config?.model || (config?.provider === 'mock' ? 'mock' : '未配置模型');
    frame.text(top + height - 1, left + 3, `${config?.mode || 'edit'} · ${model}  ${config?.provider || ''}`, s.panel, width - 5);
    if (focused) frame.cursor = {row: Math.min(top + height - 3, top + 1 + input.row - start), column: left + 3 + input.column};
  }
  private transcript(frame: Frame, top: number, height: number): void {
    const width = Math.max(1, frame.width - 6), rows: {text: string; style: string}[] = [];
    for (const entry of this.entries) {
      if (entry.kind === 'thinking' || entry.kind === 'stream_end') continue;
      if (!entry.lines || entry.width !== width) { entry.lines = wrapText(entry.text, width); entry.width = width; }
      const heading = entry.kind === 'user' ? '你' : entry.kind === 'assistant' ? 'EdaCode' : entry.kind === 'error' ? '错误' : entry.kind;
      rows.push({text: heading, style: entry.kind === 'error' ? this.styles.error : this.styles.accent});
      entry.lines.forEach(text => rows.push({text, style: this.styles.text})); rows.push({text: '', style: this.styles.base});
    }
    this.scroll = Math.min(this.scroll, Math.max(0, rows.length - height));
    const end = Math.max(0, rows.length - this.scroll), start = Math.max(0, end - height);
    rows.slice(start, end).forEach((line, i) => frame.text(top + i, 3, line.text, line.style, width));
    if (this.scroll) frame.text(top, Math.max(2, frame.width - 24), `↑ 历史 · 还有 ${this.scroll} 行`, this.styles.warning, 22);
  }
  private dialog(frame: Frame): void {
    const pending = this.pending;
    if ((!pending || pending.main) && !this.commandMenu) return;
    const width = Math.min(88, frame.width - 4), height = Math.min(frame.height - 4, Math.max(10, frame.height - 8));
    const left = Math.floor((frame.width - width) / 2), top = Math.floor((frame.height - height) / 2), inner = Math.max(1, width - 4);
    const s = this.styles;
    frame.fill(top, left, width, height, s.panel);
    frame.text(top, left, '┌' + '─'.repeat(width - 2) + '┐', s.panel);
    frame.text(top + height - 1, left, '└' + '─'.repeat(width - 2) + '┘', s.panel);
    for (let y = top + 1; y < top + height - 1; y++) { frame.text(y, left, '│', s.panel); frame.text(y, left + width - 1, '│', s.panel); }
    const isModels = pending?.models && this.modelOptions.length > 0;
    const title = this.commandMenu ? ' 命令 ' : pending?.secret ? ' 连接模型 · API key ' : isModels ? ' 选择模型 ' : pending?.prompt.includes('允许') ? ' 操作审批 ' : ' 模型配置 ';
    frame.text(top, left + 2, title, s.panel, inner);
    const options = this.commandMenu ? this.commandOptions() : isModels ? this.options() : undefined;
    const bodyHeight = height - 7;
    if (options) {
      const selected = this.commandMenu ? this.menuIndex : this.selected;
      const start = Math.max(0, selected - bodyHeight + 1);
      options.slice(start, start + bodyHeight).forEach((option, i) => {
        const active = start + i === selected, style = active ? s.selected : s.panel;
        frame.fill(top + 2 + i, left + 2, inner, 1, style);
        frame.text(top + 2 + i, left + 2, `${active ? '›' : ' '} ${this.commandMenu ? '' : option.value + '. '}${option.label}`, style, inner);
      });
      if (!options.length) frame.text(top + 2, left + 2, this.commandMenu ? '没有匹配的命令。' : '没有匹配项；可直接输入完整模型 ID。', s.panel, inner);
    } else {
      const detail = pending?.prompt.includes('允许') ? this.details : pending?.secret ? '密钥仅用于请求你配置的模型服务，输入内容不会显示或记录到对话。' : pending?.prompt || '';
      const lines = wrapText(detail, inner);
      this.dialogScroll = Math.min(this.dialogScroll, Math.max(0, lines.length - bodyHeight));
      lines.slice(this.dialogScroll, this.dialogScroll + bodyHeight).forEach((line, i) => frame.text(top + 2 + i, left + 2, line, s.panel, inner));
      if (lines.length > bodyHeight) frame.text(top + height - 6, left + 2, `PgUp/PgDn 查看完整内容 · ${this.dialogScroll + 1}/${lines.length} 行`, s.panel, inner);
    }
    const label = this.commandMenu ? '输入命令名称' : isModels ? '↑↓ 选择，或输入编号 / 模型 ID' : pending?.secret ? 'API key（隐藏输入）' : pending?.prompt || '';
    frame.text(top + height - 5, left + 2, label, s.panel, inner);
    const input = this.inputLines(inner - 2, !!pending?.secret), start = Math.max(0, input.row);
    frame.text(top + height - 4, left + 2, '❯ ' + (input.lines[start] || ''), s.panel, inner);
    frame.text(top + height - 2, left + 2, this.commandMenu ? 'Enter 填入命令 · Esc 返回' : 'Enter 确认 · Esc 取消 · Ctrl-C 中断', s.panel, inner);
    frame.cursor = {row: top + height - 4, column: Math.min(left + width - 3, left + 4 + input.column)};
  }
  private frame(): Frame {
    const width = Math.max(1, Math.min(500, (this.target.columns || 88) - 1)), height = Math.max(1, Math.min(200, this.target.rows || 30));
    const frame = new Frame(width, height, this.styles.base), config = this.config;
    if (width < 34 || height < 14) {
      frame.text(0, 0, 'EdaCode · 请放大终端窗口', this.styles.text);
      frame.text(Math.min(2, height - 1), 0, this.pending?.secret ? 'API key（隐藏输入）' : this.pending?.prompt || 'Ctrl-C 退出', this.styles.muted);
      const input = this.inputLines(width, !!this.pending?.secret);
      frame.text(Math.min(4, height - 1), 0, input.lines.at(-1) || '', this.styles.text);
      if (this.pending) frame.cursor = {row: Math.min(4, height - 1), column: Math.min(width - 1, input.column)};
      return frame;
    }
    const panelWidth = Math.min(76, width - 8), left = Math.floor((width - panelWidth) / 2);
    if (this.home) {
      const art = logo(), artWidth = visibleWidth(art[0]);
      const panelHeight = Math.min(7, height - 9, Math.max(4, this.inputLines(panelWidth - 6).lines.length + 3));
      const compact = height < panelHeight + 18, top = compact ? 1 : Math.max(1, Math.floor((height - panelHeight - 11) / 2));
      if (!compact && artWidth <= width - 4) art.forEach((line, i) => frame.text(top + i, Math.floor((width - artWidth) / 2), line, this.palette.s(`48;5;16;38;5;${244 + i * 2}`)));
      else frame.text(top + 2, Math.floor((width - 7) / 2), 'EdaCode', this.styles.text);
      const panelTop = compact ? Math.max(4, Math.floor((height - panelHeight) / 2)) : top + 7;
      this.composer(frame, panelTop, left, panelWidth, panelHeight);
      frame.text(panelTop + panelHeight + 1, left, 'Enter 发送   Alt+Enter 换行   Ctrl+P 命令', this.styles.muted, panelWidth);
    } else {
      frame.text(1, 2, `EdaCode  ${this.session ? '· ' + this.session : ''}`, this.styles.accent, width - 4);
      const inputHeight = Math.min(8, Math.max(4, this.inputLines(width - 12).lines.length + 3));
      this.transcript(frame, 3, Math.max(1, height - inputHeight - 7));
      this.composer(frame, height - inputHeight - 3, 2, width - 4, inputHeight);
    }
    frame.text(height - 3, 2, this.notice.split('\n')[0], this.styles.muted, width - 4);
    const footer = `${config ? shortenHome(config.workspace) : 'EdaCode'}  · ${this.tools?.mcp?.servers.size || 0} MCP  /status`;
    frame.text(height - 1, 2, footer, this.styles.muted, Math.max(1, width - VERSION.length - 5));
    frame.text(height - 1, width - VERSION.length - 1, VERSION, this.styles.muted);
    if (!this.home) frame.text(height - 2, 2, 'PgUp/PgDn 历史   Ctrl+P 命令   Ctrl-C 中断 / 退出', this.styles.muted, width - 4);
    this.dialog(frame);
    return frame;
  }
  snapshot(): string[] { return this.frame().plain(); }
  draw(): void {
    if (this.closed) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.target.write(this.frame().ansi(this.palette.reset));
  }
  close(): void {
    if (this.closed) return; this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    const pending = this.pending; this.pending = undefined; this.buffer = []; this.history = []; this.details = '';
    this.source.removeListener('keypress', this.keypress); this.source.removeListener('end', this.end); this.target.removeListener('resize', this.resize);
    process.removeListener('exit', this.exit);
    this.source.setRawMode(this.wasRaw); this.source.pause();
    this.target.write(this.palette.reset + '\x1b[?2004l\x1b[?25h\x1b[?1049l');
    pending?.resolve(undefined);
  }
}
