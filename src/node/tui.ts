import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { HELP } from './constants.js';
import { Palette, safeTerminal, shortenHome, VERSION, visibleWidth } from './ui.js';
import type { ApprovalDecision, Config } from './types.js';
import type { Tools } from './tools.js';
import type { ConnectionDefaults, ConnectionFields } from './connection.js';
import { inspectWorkspace, type WorkspaceStatus } from './workspace-status.js';
import { describeApproval, type ApprovalDescription } from './approval.js';
import { reviewLines } from './review.js';
import { discoverMentionFiles, fileReference, fuzzyFiles, type FileIndex } from './file-mentions.js';

export interface PromptInput {
  onInterrupt: () => void;
  read(prompt: string, signal?: AbortSignal, secret?: boolean): Promise<string | undefined>;
  close(): void;
}
type Entry = {kind: string; text: string; time: string; state?: 'running' | 'completed' | 'failed'; width?: number; lines?: string[]; tool?: string; activity?: Entry; counts?: Map<string, number>};
type Option = {value: string; label: string};
type Pending = {prompt: string; secret: boolean; main: boolean; models: boolean; approval: boolean; resolve: (value: string | undefined) => void; reject: (error: unknown) => void};
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
        // 覆盖弹窗边缘时也清除旧宽字符的另一半，防止整行错位。
        for (let j = 0; j < size; j++) {
          const x = column + used + j, cells = this.cells[row];
          if (!cells[x].char && x > 0) cells[x - 1] = {...cells[x - 1], char: ' '};
          if (cells[x + 1]?.char === '') cells[x + 1] = {...cells[x + 1], char: ' '};
          cells[x] = {...cells[x], char: ' '};
        }
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
  private workspace?: WorkspaceStatus;
  private inspection?: AbortController;
  private inspectionTask?: Promise<void>;
  private refreshAgain = false;
  private statusTimer: NodeJS.Timeout;
  private progressTimer: NodeJS.Timeout;
  private workingSince?: number;
  private activityLabel = '思考中…';
  private expandedLog = false;
  private activityGroup?: Entry;
  private lastAssistant?: Entry;
  private noBanner: boolean;
  private session = '';
  private keyboard = new PassThrough();
  private decoder = new StringDecoder('utf8');
  private rawInput = '';
  private escapeTimer?: NodeJS.Timeout;
  private pending?: Pending;
  private approvalState?: {description: ApprovalDescription; selected: number; expanded: boolean};
  private dialogPageHeight = 1;
  private connection?: {defaults: ConnectionDefaults; fields: ConnectionFields; field: number; error?: string};
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
  private menuDraft?: {buffer: string[]; cursor: number};
  private menuIndex = 0;
  private fileMenu?: {start: number; end: number; query: string; index: number; options: string[]};
  private fileIndex?: FileIndex;
  private fileScan?: AbortController;
  private fileLoading = false;
  private fileError = '';
  private dismissedMention = '';
  private viewTop: number | undefined;
  private reveal?: Entry;
  private taskStart = 0;
  private navigated = false;
  private viewport = {start: 0, height: 1, total: 0};
  private scrollInfo = '';
  private dialogScroll = 0;
  private pasting = false;
  private closed = false;
  private timer?: NodeJS.Timeout;
  private wasRaw: boolean;
  private commands = HELP.split('\n').map(line => ({value: line.match(/^(\/[^\s[<]+)/)?.[1] || '', label: line})).filter(item => item.value);
  private styles: {base: string; panel: string; text: string; muted: string; accent: string; selected: string; warning: string; error: string; border: string; success: string};
  constructor(private source: NodeJS.ReadStream = process.stdin, private target: NodeJS.WriteStream = process.stdout,
    private palette = new Palette(true), noBanner = false) {
    this.home = !noBanner; this.noBanner = noBanner; this.wasRaw = !!source.isRaw;
    const color = (spec: string) => palette.s(spec);
    this.styles = {base: color('48;5;232;38;5;252'), panel: color('48;5;233;38;5;252'), text: color('48;5;232;38;5;252'),
      muted: color('48;5;232;38;5;245'), accent: color('48;5;232;38;5;75'), selected: color('48;5;24;38;5;255'),
      warning: color('48;5;232;38;5;221'), error: color('48;5;232;38;5;203'), border: color('48;5;232;38;5;239'), success: color('48;5;232;38;5;78')};
    readline.emitKeypressEvents(this.keyboard);
    this.keyboard.on('keypress', this.keypress);
    source.on('data', this.inputData); source.on('end', this.end); target.on('resize', this.resize);
    process.on('exit', this.exit);
    source.setRawMode(true); source.resume();
    this.statusTimer = setInterval(() => { void this.refreshWorkspace(); }, 15_000);
    this.statusTimer.unref();
    this.progressTimer = setInterval(() => { if (this.workingSince !== undefined) this.schedule(); }, 1000);
    this.progressTimer.unref();
    target.write('\x1b[?1049h\x1b[?2004h\x1b[?1000h\x1b[?1006h\x1b[2J\x1b[H'); this.draw();
  }
  setContext(config: Config, tools?: Tools, session = ''): void {
    const changed = this.config?.workspace !== config.workspace;
    this.config = config; this.tools = tools;
    if (session && session !== this.session) {
      this.session = session;
      const messages = tools?.store.data.messages;
      if (Array.isArray(messages) && messages.length) {
        const restored = messages.filter(message => ['user', 'assistant'].includes(message.role) && message.content)
          .map(message => ({...this.entry(message.role === 'assistant' && message.tool_calls?.length ? 'progress' : message.role, safeTerminal(message.content)), time: ''}));
        this.entries = [...restored, ...this.entries]; this.home = false;
        this.reveal = restored.findLast(entry => entry.kind === 'assistant') || restored.at(-1);
      }
    }
    if (changed) { this.inspection?.abort(); this.inspectionTask = undefined; this.workspace = undefined; this.resetFileMenu(); this.fileIndex = undefined; }
    if (!this.workspace) void this.refreshWorkspace();
    this.notice = config.provider === 'mock' ? '离线演示 · /connect 连接模型' : !config.api_key ? '尚未连接模型 · 输入 /connect 开始配置'
      : !config.model ? '接口已配置 · 输入 /model 选择模型' : '输入任务开始 · /help 查看命令';
    this.schedule();
  }
  refreshWorkspace(force = false): Promise<void> {
    if (this.closed || !this.config) return Promise.resolve();
    if (this.inspectionTask) { this.refreshAgain ||= force; return this.inspectionTask; }
    const controller = new AbortController(); this.inspection = controller;
    const {workspace, home} = this.config;
    const task = inspectWorkspace(workspace, controller.signal, home).then(status => {
      if (!this.closed && this.inspection === controller) { this.workspace = status; this.schedule(); }
    }).catch(() => {}).finally(() => {
      if (this.inspection === controller) {
        this.inspectionTask = undefined;
        if (this.refreshAgain) { this.refreshAgain = false; void this.refreshWorkspace(); }
      }
    });
    this.inspectionTask = task; return task;
  }
  private entry(kind: string, text: string, state?: Entry['state']): Entry {
    return {kind, text, state, time: new Date().toLocaleTimeString('en-GB', {hour12: false})};
  }
  finishTask(): void {
    // 中断和错误不能被绘制为成功完成。
    for (const entry of this.entries) if (entry.state === 'running') entry.state = 'failed';
    this.workingSince = undefined; this.activityGroup = undefined;
    if (this.entries.at(-1)?.kind !== 'info') this.notice = '就绪 · 输入任务开始';
    if (!this.navigated) this.reveal = this.entries.slice(this.taskStart).findLast(entry =>
      !['user', 'thinking', 'tool', 'result', 'diff', 'activity', 'progress'].includes(entry.kind));
    void this.refreshWorkspace(true); this.schedule();
  }
  submitted(text: string): void {
    this.workingSince = Date.now(); this.activityLabel = '思考中…'; this.activityGroup = undefined;
    this.viewTop = undefined; this.reveal = undefined; this.navigated = false; this.taskStart = this.entries.length;
    if (text === '/clear') { this.home = true; this.entries = []; this.streaming = undefined; this.notice = '对话已清空 · 输入任务开始'; this.schedule(); return; }
    if (/^\/(connect|model)(?:\s|$)/.test(text)) return;
    if (this.home) { this.entries = []; this.taskStart = 0; }
    this.home = false; this.entries.push(this.entry('user', text)); this.schedule();
  }
  display = (kind: string, value: string): void => {
    if (this.closed) return;
    const text = safeTerminal(value);
    if (kind === 'assistant_phase') {
      if (this.lastAssistant) { this.lastAssistant.kind = text === 'progress' ? 'progress' : 'assistant'; this.lastAssistant.lines = undefined; }
      if (text === 'final') this.activityGroup = undefined;
      this.schedule(); return;
    }
    if (kind === 'thinking') { this.workingSince ??= Date.now(); this.activityLabel = text.includes('重试') ? text : '思考中…'; }
    if (kind === 'tool') this.toolActivity(text);
    if (kind === 'stream' || kind === 'assistant') this.activityLabel = '正在生成回复…';
    if (['stream', 'assistant', 'tool', 'result'].includes(kind)) {
      for (const entry of this.entries) if (entry.kind === 'thinking' && entry.state === 'running') entry.state = 'completed';
    }
    if (kind === 'error' || kind === 'cancelled') {
      for (const entry of this.entries) if (entry.state === 'running') entry.state = 'failed';
    }
    if (kind === 'result') {
      const name = text.split(/[ :]/)[0];
      const tool = this.entries.findLast(entry => entry.kind === 'tool' && entry.state === 'running' && entry.text.split(' ')[0] === name);
      if (tool) {
        tool.state = text.startsWith(name + ' [失败]') ? 'failed' : 'completed';
        const activity = tool.activity;
        if (activity) {
          if (activity.counts) {
            const label = name === 'read_file' ? '读取文件' : name === 'list_files' ? '查看目录' : name === 'search' ? '搜索' : '读取上下文';
            const key = tool.state === 'failed' ? '失败' : label;
            activity.counts.set(key, (activity.counts.get(key) || 0) + 1);
            activity.text = [...activity.counts].map(([label, count]) => `${label} ${count} 次`).join(' · ');
            activity.state = activity.counts.has('失败') ? 'failed' : 'completed';
          } else {
            activity.state = tool.state;
            if (tool.state === 'failed') activity.text += ' · ' + text.slice(text.indexOf(':') + 1).trim().split('\n')[0];
          }
          activity.lines = undefined;
        }
      }
    }
    if (kind === 'stream') {
      if (!this.streaming) { this.streaming = this.entry('assistant', ''); this.entries.push(this.streaming); this.lastAssistant = this.streaming; }
      this.streaming.text += text; this.streaming.lines = undefined;
    } else if (kind === 'stream_end') this.streaming = undefined;
    else {
      const entry = this.entry(kind, text, ['thinking', 'tool'].includes(kind) ? 'running' : undefined);
      if (kind === 'tool') { entry.activity = this.activityGroup; entry.tool = text.split(' ')[0]; }
      this.entries.push(entry);
      if (kind === 'assistant') this.lastAssistant = entry;
      if (kind === 'info') {
        this.details = text;
        this.modelOptions = text.split('\n').flatMap(line => {
          const match = line.match(/^\s+(\d+)\. (.+)$/); return match ? [{value: match[1], label: match[2]}] : [];
        });
      }
      if (text && !['tool', 'result', 'thinking', 'diff'].includes(kind)) {
        const lines = text.split('\n');
        this.notice = lines.find(line => /^(接口已配置|当前会话已切换)/.test(line)) || lines[0];
      }
    }
    this.schedule();
  };
  private toolActivity(text: string): void {
    const name = text.split(' ')[0]; let args: any = {};
    try { args = JSON.parse(text.slice(name.length).trim()); } catch { /* 自定义命令的预告不作为真实工具步骤。 */ }
    if (name === '自定义命令注入') return;
    const grouped = ['read_file', 'list_files', 'search', 'read_artifact', 'load_skill'].includes(name);
    const labels: Record<string, string> = {read_file: '读取文件', list_files: '查看目录', search: '搜索代码', write_file: '修改文件', edit_file: '修改文件',
      shell: '运行终端命令', update_plan: '更新计划', delegate: '调查项目', read_artifact: '读取上下文', load_skill: '加载技能', job_status: '检查后台任务'};
    const label = labels[name] || '调用工具 ' + name;
    this.activityLabel = label + (args.path ? ' ' + args.path : '…');
    if (!grouped || !this.activityGroup?.counts) {
      this.activityGroup = this.entry('activity', this.activityLabel, 'running');
      if (grouped) this.activityGroup.counts = new Map();
      this.entries.push(this.activityGroup);
    } else this.activityGroup.state = 'running';
  }
  async confirmApproval(name: string, detail: string, signal?: AbortSignal): Promise<ApprovalDecision> {
    const description = describeApproval(name, detail, this.config?.workspace);
    this.approvalState = {description, selected: description.file ? 2 : 1, expanded: false};
    try { const answer = await this.read('操作审批', signal); return answer === 'session_edits' ? 'session_edits' : answer === 'y'; }
    finally { this.approvalState = undefined; this.dialogScroll = 0; this.schedule(); }
  }
  async configureConnection(defaults: ConnectionDefaults, signal?: AbortSignal): Promise<ConnectionFields | undefined> {
    const state = {defaults, fields: {provider: defaults.provider, base_url: defaults.base_url, api_key: ''}, field: 0};
    const pending = this.read('连接模型', signal);
    this.connection = state; this.buffer = chars(defaults.base_url); this.cursor = this.buffer.length; this.draw();
    try {
      const answer = await pending;
      return answer === undefined ? undefined : {...state.fields};
    } finally {
      state.fields.api_key = ''; this.connection = undefined; this.buffer = []; this.cursor = 0; this.schedule();
    }
  }
  private saveConnectionField(): void {
    const state = this.connection;
    if (state?.field === 0) state.fields.base_url = this.buffer.join('');
    else if (state?.field === 1) state.fields.api_key = this.buffer.join('');
  }
  private focusConnectionField(field: number): void {
    const state = this.connection; if (!state || !this.pending) return;
    this.saveConnectionField(); state.field = (field + 4) % 4;
    this.buffer = chars(state.field === 0 ? state.fields.base_url : state.field === 1 ? state.fields.api_key : '');
    this.cursor = this.buffer.length; this.pending.secret = state.field === 1; this.schedule();
  }
  async read(prompt: string, signal?: AbortSignal, secret = false): Promise<string | undefined> {
    signal?.throwIfAborted(); if (this.closed) return;
    const label = safeTerminal(prompt).trim();
    this.resetFileMenu(); this.dismissedMention = '';
    this.buffer = []; this.cursor = 0; this.selected = -1; this.dialogScroll = 0;
    this.historyIndex = this.history.length; this.commandMenu = false; this.menuDraft = undefined;
    let abort: (() => void) | undefined;
    try {
      return await new Promise<string | undefined>((resolve, reject) => {
        this.pending = {prompt: label, secret, main: !label || label === '❯' || label === '…', models: label.includes('选择模型编号'), approval: !!this.approvalState, resolve, reject};
        abort = () => { this.resetFileMenu(); this.pending = undefined; this.buffer = []; this.cursor = 0; this.commandMenu = false; this.menuDraft = undefined; reject(signal?.reason); this.schedule(); };
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
    this.resetFileMenu(); this.pending = undefined; this.buffer = []; this.cursor = 0; this.commandMenu = false; this.menuDraft = undefined;
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
  private dismissCommands(): void {
    if (this.menuDraft) { this.buffer = this.menuDraft.buffer; this.cursor = this.menuDraft.cursor; }
    this.menuDraft = undefined; this.commandMenu = false;
  }
  private resetFileMenu(): void {
    this.fileScan?.abort(); this.fileScan = undefined; this.fileLoading = false; this.fileMenu = undefined;
  }
  private syncFileMenu(): void {
    if (!this.pending?.main || this.commandMenu || this.pasting) { this.resetFileMenu(); return; }
    const prefix = this.buffer.slice(0, this.cursor).join('');
    const match = prefix.match(/(?:^|[^\p{L}\p{N}_@])@([^\s@"{}]*)$/u);
    if (!match) { this.resetFileMenu(); this.dismissedMention = ''; return; }
    const query = match[1], start = this.cursor - chars(query).length - 1, signature = `${start}:${query}`;
    if (signature === this.dismissedMention) { this.resetFileMenu(); return; }
    let end = this.cursor;
    while (end < this.buffer.length && !/[\s@"{}]/.test(this.buffer[end])) end++;
    const previous = this.fileMenu;
    const options = previous?.query === query ? previous.options : fuzzyFiles(this.fileIndex?.files || [], query);
    this.fileMenu = {start, end, query, options, index: previous?.query === query ? previous.index : 0};
    if (!previous) void this.scanMentionFiles();
  }
  private async scanMentionFiles(): Promise<void> {
    if (!this.config) return;
    this.fileScan?.abort(); const controller = new AbortController(); this.fileScan = controller;
    this.fileLoading = true; this.fileError = '';
    try {
      const index = await discoverMentionFiles(this.config.workspace, this.config.home, controller.signal);
      if (this.closed || controller.signal.aborted || this.fileScan !== controller) return;
      this.fileIndex = index;
      if (this.fileMenu) { this.fileMenu.options = fuzzyFiles(index.files, this.fileMenu.query); this.fileMenu.index = 0; }
    } catch {
      if (!controller.signal.aborted && this.fileScan === controller) { this.fileError = '无法读取工作区文件'; this.fileIndex = undefined; if (this.fileMenu) this.fileMenu.options = []; }
    } finally {
      if (this.fileScan === controller) { this.fileLoading = false; this.fileScan = undefined; this.schedule(); }
    }
  }
  private chooseFile(): void {
    const menu = this.fileMenu, file = menu?.options[menu.index];
    if (!menu || !file || this.fileLoading) return;
    const reference = chars(fileReference(file));
    const space = this.buffer[menu.end] === ' ' ? [] : [' '];
    this.buffer.splice(menu.start, menu.end - menu.start, ...reference, ...space);
    this.cursor = menu.start + reference.length + 1;
    this.resetFileMenu(); this.dismissedMention = ''; this.schedule();
  }
  /** 先消费鼠标报告，再交给 readline；否则滚轮坐标会成为输入框里的数字。 */
  private inputData = (chunk: Buffer | string): void => {
    if (this.closed) return;
    if (this.escapeTimer) { clearTimeout(this.escapeTimer); this.escapeTimer = undefined; }
    this.rawInput += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    while (this.rawInput) {
      const index = this.rawInput.search(/\x1b\[(?:<|M)/);
      if (index < 0) {
        const suffix = this.rawInput.match(/\x1b\[?$/)?.[0] || '';
        const ready = this.rawInput.slice(0, this.rawInput.length - suffix.length);
        this.rawInput = suffix; if (ready) this.keyboard.write(ready);
        if (suffix) {
          this.escapeTimer = setTimeout(() => { this.escapeTimer = undefined; const value = this.rawInput; this.rawInput = ''; if (!this.closed) this.keyboard.write(value); }, 20);
          this.escapeTimer.unref();
        }
        return;
      }
      if (index > 0) { const ready = this.rawInput.slice(0, index); this.rawInput = this.rawInput.slice(index); this.keyboard.write(ready); }
      let button: number, length: number, pressed = true;
      if (this.rawInput.startsWith('\x1b[<')) {
        const match = this.rawInput.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
        if (!match) {
          if (/^\x1b\[<[\d;]*$/.test(this.rawInput) && this.rawInput.length < 64) return;
          this.rawInput = this.rawInput.replace(/^\x1b\[<[\d;]*/, ''); continue;
        }
        button = Number(match[1]); length = match[0].length; pressed = match[4] === 'M';
      } else {
        if (this.rawInput.length < 6) return;
        button = this.rawInput.charCodeAt(3) - 32; length = 6;
      }
      this.rawInput = this.rawInput.slice(length);
      if (!this.pasting && pressed && (button & 64)) this.scrollBy(button & 1 ? 3 : -3);
    }
  };
  private scrollBy(lines: number): void {
    if (this.fileMenu) {
      this.fileMenu.index = Math.max(0, Math.min(this.fileMenu.options.length - 1, this.fileMenu.index + lines)); this.schedule(); return;
    }
    if (this.connection || this.commandMenu || this.pending?.models) return;
    if (this.pending && !this.pending.main) this.dialogScroll = Math.max(0, this.dialogScroll + lines);
    else {
      if (this.reveal) this.frame();
      this.navigated = true; this.reveal = undefined;
      const maximum = Math.max(0, this.viewport.total - this.viewport.height);
      this.viewTop = Math.max(0, Math.min(maximum, (this.viewTop ?? this.viewport.start) + lines));
      if (this.viewTop === maximum) this.viewTop = undefined;
    }
    this.schedule();
  }
  private keypress = (text: string | undefined, key: readline.Key): void => {
    if (this.closed) return;
    if (key.name === 'paste-start') { this.pasting = true; return; }
    if (key.name === 'paste-end') { this.pasting = false; this.syncFileMenu(); this.schedule(); return; }
    if (this.pasting) { if (this.pending && !this.pending.approval && text && (!this.connection || this.connection.field < 2)) this.insert(text); this.schedule(); return; }
    if (key.ctrl && key.name === 'c') { this.onInterrupt(); return; }
    if (key.ctrl && key.name === 'd') { this.onInterrupt(); this.close(); return; }
    if (key.name === 'pageup' || key.name === 'pagedown') {
      this.scrollBy(Math.max(1, (this.pending?.approval ? this.dialogPageHeight : this.viewport.height) - 1) * (key.name === 'pageup' ? -1 : 1)); return;
    }
    if (key.ctrl && (key.name === 'home' || key.name === 'end')) {
      if (this.connection || this.commandMenu || this.pending?.models) return;
      if (this.pending && !this.pending.main) this.dialogScroll = key.name === 'home' ? 0 : Number.MAX_SAFE_INTEGER;
      else { this.navigated = true; this.reveal = undefined; this.viewTop = key.name === 'home' ? 0 : undefined; }
      this.schedule(); return;
    }
    if (key.ctrl && key.name === 'l') { this.draw(); return; }
    if (key.ctrl && key.name === 'o' && !this.approvalState && !this.connection && !this.commandMenu && !this.pending?.models) {
      this.expandedLog = !this.expandedLog; this.viewTop = undefined; this.reveal = undefined;
      this.notice = this.expandedLog ? '已展开执行详情 · Ctrl+O 收起' : '已收起执行详情'; this.schedule(); return;
    }
    const pending = this.pending; if (!pending) return;
    if (pending.approval && this.approvalState) {
      const state = this.approvalState;
      const count = state.description.file ? 3 : 2;
      if (key.name === 'up' || key.name === 'down') state.selected = (state.selected + (key.name === 'up' ? -1 : 1) + count) % count;
      else if (key.name === 'return' || key.name === 'enter') { this.complete(state.selected === 0 ? 'y' : state.description.file && state.selected === 1 ? 'session_edits' : 'n'); return; }
      else if (key.name === 'escape') { this.complete('n'); return; }
      else if (key.name === 'tab' && key.shift && state.description.file) state.selected = 1;
      else if (key.name === 'tab' || text === 'd') { state.expanded = !state.expanded; this.dialogScroll = 0; }
      else if (text?.toLowerCase() === 'y') state.selected = 0;
      else if (text?.toLowerCase() === 'n') state.selected = count - 1;
      else if (text && /^[1-3]$/.test(text) && Number(text) <= count) state.selected = Number(text) - 1;
      this.schedule(); return;
    }
    if (this.connection) {
      const state = this.connection;
      if (key.name === 'tab' || key.name === 'up' || key.name === 'down') {
        this.focusConnectionField(state.field + (key.shift || key.name === 'up' ? -1 : 1)); return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        if (state.field === 0) this.focusConnectionField(1);
        else {
          this.saveConnectionField();
          if (!state.fields.api_key.trim() && !(state.defaults.has_key && state.fields.provider === state.defaults.provider)) {
            state.error = '请输入 API key 后再连接'; this.focusConnectionField(1);
          } else this.complete('');
        }
        return;
      }
      if (state.field === 2 && ['left', 'right', 'space', '1', '2'].includes(key.name || text || '')) {
        state.fields.provider = text === '1' ? 'openai' : text === '2' ? 'anthropic' : state.fields.provider === 'openai' ? 'anthropic' : 'openai';
        this.schedule(); return;
      }
      if (state.field >= 2 && key.name !== 'escape') return;
    }
    if (key.ctrl && key.name === 'p' && pending.main) {
      this.resetFileMenu();
      if (this.commandMenu) this.dismissCommands();
      else { this.menuDraft = {buffer: [...this.buffer], cursor: this.cursor}; this.buffer = []; this.cursor = 0; this.commandMenu = true; this.menuIndex = 0; }
      this.schedule(); return;
    }
    if (this.fileMenu) {
      if (key.name === 'escape') { this.dismissedMention = `${this.fileMenu.start}:${this.fileMenu.query}`; this.resetFileMenu(); this.schedule(); return; }
      if (['return', 'enter', 'tab'].includes(key.name || '') && !key.meta && !key.shift) { this.chooseFile(); return; }
      if (key.name === 'up' || key.name === 'down') {
        const count = this.fileMenu.options.length;
        this.fileMenu.index = count ? (this.fileMenu.index + (key.name === 'up' ? -1 : 1) + count) % count : 0;
        this.schedule(); return;
      }
    }
    if (key.name === 'escape') {
      if (this.commandMenu) this.dismissCommands();
      else if (!pending.main) { this.complete(undefined); return; }
      else { this.buffer = []; this.cursor = 0; }
    } else if (key.name === 'return' || key.name === 'enter') {
      if (pending.main && (key.meta || key.shift)) this.insert('\n');
      else if (this.commandMenu) {
        const option = this.commandOptions()[this.menuIndex];
        if (option) { this.buffer = chars(option.value); this.cursor = this.buffer.length; this.commandMenu = false; this.menuDraft = undefined; }
        else this.dismissCommands();
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
    this.syncFileMenu(); this.schedule();
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
  private box(frame: Frame, top: number, left: number, width: number, height: number, title = ''): void {
    const s = this.styles;
    frame.fill(top, left, width, height, s.panel);
    frame.text(top, left, '╭' + '─'.repeat(Math.max(0, width - 2)) + '╮', s.border, width);
    frame.text(top + height - 1, left, '╰' + '─'.repeat(Math.max(0, width - 2)) + '╯', s.border, width);
    for (let y = top + 1; y < top + height - 1; y++) {
      frame.text(y, left, '│', s.border); frame.text(y, left + width - 1, '│', s.border);
    }
    if (title) frame.text(top + 1, left + 2, title, this.palette.s('48;5;233;38;5;255'), width - 4);
  }
  private composer(frame: Frame, top: number, left: number, width: number, height: number): void {
    this.box(frame, top, left + 3, width - 3, height);
    const s = this.styles, input = this.inputLines(Math.max(1, width - 9));
    const available = height - 2, start = Math.max(0, input.row - available + 1);
    const focused = !!this.pending?.main && !this.commandMenu;
    frame.text(top + 1, left, '❯', s.accent);
    if (!this.buffer.length || !this.pending?.main) frame.text(top + 1, left + 5,
      focused ? 'Type a message or / for commands…' : '正在处理… Ctrl-C 中断', this.palette.s('48;5;233;38;5;245'), width - 8);
    else input.lines.slice(start, start + available).forEach((line, i) => frame.text(top + 1 + i, left + 5, line, s.panel, width - 8));
    if (focused) frame.cursor = {row: top + 1 + input.row - start, column: left + 5 + input.column};
  }
  private mentionMenu(frame: Frame, inputTop: number): void {
    const menu = this.fileMenu; if (!menu) return;
    const width = Math.min(92, frame.width - 4), left = 2;
    const capacity = Math.max(1, Math.min(8, inputTop - 7));
    const count = Math.min(capacity, Math.max(1, menu.options.length)), height = count + 5;
    const top = Math.max(0, inputTop - height), inner = width - 4, s = this.styles;
    this.box(frame, top, left, width, height, `引用文件 · ${menu.options.length} 项${this.fileIndex?.limited ? '（索引已达上限）' : ''}`);
    const start = Math.max(0, menu.index - count + 1);
    if (this.fileLoading || !menu.options.length) frame.text(top + 2, left + 2,
      this.fileLoading ? '正在查找工作区文件…' : this.fileError || '没有匹配文件，试试更短的关键词', s.panel, inner);
    else menu.options.slice(start, start + count).forEach((file, i) => {
      const style = menu.index === start + i ? s.selected : s.panel;
      frame.fill(top + 2 + i, left + 2, inner, 1, style);
      // 长路径保留文件名，避免同目录的候选看起来完全相同。
      let label = file;
      if (visibleWidth(label) > inner - 2) { const tail = chars(label); while (tail.length && visibleWidth(tail.join('')) > inner - 3) tail.shift(); label = '…' + tail.join(''); }
      frame.text(top + 2 + i, left + 2, `${menu.index === start + i ? '›' : ' '} ${label}`, style, inner);
    });
    frame.text(top + height - 2, left + 2, '↑↓ 选择 · Enter/Tab 插入 · Esc 关闭', s.panel, inner);
  }
  private hero(frame: Frame, left: number, width: number): number {
    const s = this.styles, config = this.config;
    if (!this.home) {
      frame.text(1, left, `edacode v${VERSION} · ${config?.model || '未配置模型'} · ${config?.mode || 'edit'}`, s.accent, width);
      frame.text(2, left, config ? shortenHome(config.workspace) : '正在加载…', s.muted, width);
      frame.text(3, left, '─'.repeat(width), s.border, width);
      return 4;
    }
    const art = [
      '          __                       __',
      '   ___   / /___ _ _____ ____   ____/ /___',
      '  / _ \\/ // _ `// ___// __ \\ / __  // _ \\',
      ' /  __/ // /_/ // /__ / /_/ // /_/ //  __/',
      ' \\___/_/ \\__,_/ \\___/ \\____/ \\__,_/ \\___/',
    ];
    const large = this.home && !this.noBanner && frame.height >= 28 && width >= 58;
    let row = 1;
    if (large) {
      const colors = [81, 75, 111, 141, 177];
      for (const line of art) {
        chars(line).forEach((char, i) => frame.text(row, left + i, char, this.palette.s(`48;5;232;38;5;${colors[Math.min(4, Math.floor(i * 5 / 46))]}`)));
        row++;
      }
      frame.text(++row, left, 'Your autonomous engineering team in terminal.', s.text, width); row++;
    } else { frame.text(row++, left, 'edacode', s.accent, width); }
    frame.text(row++, left, `v${VERSION}`, s.muted, width);
    frame.text(row++, left, `◇ Model: ${config?.model || (config?.provider === 'mock' ? 'mock' : '未配置 · /connect')}`, s.text, width);
    frame.text(row++, left, `▸ Workspace: ${config ? shortenHome(config.workspace) : '正在加载…'}`, s.text, width);
    frame.text(row++, left, '─'.repeat(width), s.border, width);
    return row;
  }
  private transcript(frame: Frame, top: number, left: number, width: number, height: number): void {
    if (height < 1) return;
    const s = this.styles, inner = Math.max(1, width - 4), rows: {text: string; style: string; panel?: boolean}[] = [];
    const visibleProgress = new Set<Entry>(); let previousProgress: Entry | undefined;
    for (const entry of this.entries) {
      if (entry.kind === 'user') previousProgress = undefined;
      if (entry.kind === 'progress') { if (previousProgress) visibleProgress.delete(previousProgress); visibleProgress.add(entry); previousProgress = entry; }
    }
    let revealRow: number | undefined;
    for (const entry of this.entries) {
      if (!this.expandedLog && ['thinking', 'tool', 'result', 'diff'].includes(entry.kind)) continue;
      if (!this.expandedLog && entry.kind === 'progress' && !visibleProgress.has(entry)) continue;
      if (entry === this.reveal) revealRow = rows.length;
      if (!entry.lines || entry.width !== inner) { entry.lines = wrapText(entry.text, inner); entry.width = inner; }
      const marker = entry.state === 'failed' || entry.kind === 'error' ? '✕' : entry.state === 'completed' ? '✓' : entry.state === 'running' ? '○' : entry.kind === 'user' ? '❯' : '│';
      const style = marker === '✕' ? s.error : marker === '✓' ? s.success : entry.kind === 'user' || entry.state === 'running' ? s.accent : s.text;
      if (entry.kind === 'activity') {
        rows.push({text: `${marker} ${entry.text}`, style: entry.state === 'failed' ? s.error : s.muted});
        continue;
      } else if (entry.kind === 'progress' && !this.expandedLog) {
        const lines = entry.lines.slice(0, 2);
        lines.forEach((line, index) => rows.push({text: (index ? '  ' : '• ') + line + (index === lines.length - 1 && entry.lines!.length > 2 ? '…' : ''), style: s.muted}));
      } else if (entry.kind === 'user') {
        rows.push({text: '❯ edacode ❯', style: s.accent});
        entry.lines.forEach(line => rows.push({text: '  ' + line, style: s.text}));
      } else {
        const label = entry.kind === 'assistant' ? 'EdaCode' : entry.kind === 'progress' ? '进度说明' : entry.kind === 'tool' ? '执行工具' : entry.kind === 'result' ? '工具结果' : entry.kind === 'thinking' ? '请求模型' : entry.kind === 'error' ? '错误' : '提示';
        rows.push({text: `${marker} ${label}`, style});
        entry.lines.forEach(line => rows.push({text: '  ' + line, style: entry.kind === 'error' ? s.error : s.text}));
      }
      rows.push({text: '', style: s.base});
    }
    const plan = this.tools?.store.data.todos || [];
    if (plan.length) {
      rows.push({text: '╭─ Plan ' + '─'.repeat(Math.max(0, width - 9)) + '╮', style: s.accent});
      plan.forEach((item: {step: string; status: string}, i: number) => {
        const marker = item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '○' : '·';
        const color = item.status === 'completed' ? 78 : item.status === 'in_progress' ? 75 : 252;
        wrapText(`${i + 1}. ${marker} ${item.step}`, Math.max(1, width - 4)).forEach(line => rows.push({text: '│ ' + line, style: this.palette.s(`48;5;233;38;5;${color}`), panel: true}));
      });
      rows.push({text: '╰' + '─'.repeat(Math.max(0, width - 2)) + '╯', style: s.border});
    }
    if (!rows.length) {
      rows.push({text: '❯ 开始你的下一个代码任务', style: s.accent}, {text: '', style: s.base});
      wrapText(this.notice, inner).forEach(text => rows.push({text: '  ' + text, style: s.muted}));
      rows.push({text: '', style: s.base}, {text: '  /connect 连接模型   /model 选择模型', style: s.muted});
    }
    const maximum = Math.max(0, rows.length - height);
    if (revealRow !== undefined) { this.viewTop = Math.min(revealRow, maximum); this.reveal = undefined; }
    const start = Math.max(0, Math.min(maximum, this.viewTop ?? maximum)), end = Math.min(rows.length, start + height);
    this.viewport = {start, height, total: rows.length};
    this.scrollInfo = rows.length > height ? `对话 ${start + 1}–${end}/${rows.length} · ${start ? '↑ 前文  ' : ''}${end < rows.length ? '↓ 后文  ' : ''}滚轮 / PgUp PgDn` : '滚轮 / PgUp PgDn 查看历史';
    rows.slice(start, end).forEach((line, i) => {
      if (line.panel) { frame.fill(top + i, left, width, 1, s.panel); frame.text(top + i, left + width - 1, '│', s.border); }
      frame.text(top + i, left, line.text, line.style, width);
    });
  }
  private sidebar(frame: Frame, left: number, width: number, available: number): void {
    const s = this.styles, status = this.workspace, panelText = this.palette.s('48;5;233;38;5;252');
    for (let row = 1; row < available; row++) frame.text(row, left - 2, '│', s.border);
    this.box(frame, 1, left, width, 8, '● Workspace Status');
    frame.text(2, left + 2, '●', status ? s.success : s.muted);
    const field = (row: number, label: string, value: string) => {
      frame.text(row, left + 2, label, panelText, 11);
      frame.text(row, left + 14, value, panelText, width - 16);
    };
    field(3, 'Project', status?.project || '加载中…');
    field(4, 'Branch', status?.branch || '—');
    field(5, 'Git Status', status?.git === 'clean' ? '✓ Clean' : status?.git === 'modified' ? `● ${status.changes} changed` : status ? '非 Git / 不可用' : '检查中…');
    field(6, 'Files¹', status?.files === undefined ? '—' : `${status.files}${status.limited ? '+' : ''}`);
    this.box(frame, 10, left, width, 7, 'Model & Tools');
    const model = this.config?.model || (this.config?.provider === 'mock' ? 'mock' : '未配置');
    frame.text(12, left + 2, model, panelText, width - 4);
    frame.text(13, left + 2, `${this.config?.provider || '—'} · ${this.config?.mode || 'edit'} · ${this.tools?.mcp?.servers.size || 0} MCP`, panelText, width - 4);
    const names = [...(this.tools?.definitions.keys() || [])];
    const badges = [names.includes('read_file') && 'FS', names.includes('shell') && 'Terminal', status?.git !== 'unavailable' && status?.git && 'Git', names.some(name => /browser/i.test(name)) && 'Browser', names.includes('search') && 'Search'].filter(Boolean).map(name => `[${name}]`);
    wrapText(badges.join(' ') || '正在加载工具…', width - 4).slice(0, 2).forEach((line, i) => frame.text(14 + i, left + 2, line, this.palette.s('48;5;233;38;5;75'), width - 4));
    const height = Math.max(5, available - 18);
    this.box(frame, 18, left, width, height, '↻ Recent Activity');
    const events = this.entries.filter(entry => ['activity', 'progress', 'error', 'user'].includes(entry.kind)).slice(-Math.max(1, Math.min(4, height - 3)));
    events.forEach((entry, i) => {
      const title = entry.kind === 'user' ? '任务 · ' + entry.text : entry.text.split('\n')[0];
      frame.text(20 + i, left + 2, '● ' + title, panelText, width - 15);
      frame.text(20 + i, left + width - 10, entry.time, this.palette.s('48;5;233;38;5;245'), 8);
    });
    if (!events.length) frame.text(20, left + 2, '等待第一个任务', panelText, width - 4);
  }
  private dialog(frame: Frame): void {
    if (this.connection) { this.connectionDialog(frame); return; }
    if (this.pending?.approval && this.approvalState) { this.approvalDialog(frame); return; }
    const pending = this.pending;
    if ((!pending || pending.main) && !this.commandMenu) return;
    const width = Math.min(88, frame.width - 4), inner = Math.max(1, width - 4);
    const isModels = pending?.models && this.modelOptions.length > 0;
    const options = this.commandMenu ? this.commandOptions() : isModels ? this.options() : undefined;
    const detail = pending?.prompt.includes('允许') ? this.details : pending?.secret ? '密钥仅用于请求你配置的模型服务，输入内容不会显示或记录到对话。' : pending?.prompt || '';
    const detailLines = wrapText(detail, inner);
    const height = Math.min(frame.height - 4, Math.max(10, (options ? Math.min(options.length, 12) : detailLines.length) + 7));
    const left = Math.floor((frame.width - width) / 2), top = Math.floor((frame.height - height) / 2);
    const s = this.styles;
    frame.fill(top, left, width, height, s.panel);
    frame.text(top, left, '╭' + '─'.repeat(width - 2) + '╮', s.panel);
    frame.text(top + height - 1, left, '╰' + '─'.repeat(width - 2) + '╯', s.panel);
    for (let y = top + 1; y < top + height - 1; y++) { frame.text(y, left, '│', s.panel); frame.text(y, left + width - 1, '│', s.panel); }
    const title = this.commandMenu ? ' 命令 ' : pending?.secret ? ' 连接模型 · API key ' : isModels ? ' 选择模型 ' : pending?.prompt.includes('允许') ? ' 操作审批 ' : ' 模型配置 ';
    frame.text(top, left + 2, title, s.panel, inner);
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
      const lines = detailLines;
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
  private approvalDialog(frame: Frame): void {
    const state = this.approvalState!, description = state.description, s = this.styles;
    const left = 2, width = Math.max(1, frame.width - 4), inner = Math.max(1, width - 2);
    // 审批是独立的审阅页面，只画当前操作，避免会话和侧栏干扰。
    frame.text(1, left, description.file ? '修改文件' : description.title, s.accent, width);
    frame.text(2, left, description.file || (description.command ? '即将在当前项目中执行以下命令' : description.summary[0] || ''), s.text, width);
    frame.text(3, left, '─'.repeat(width), s.border, width);
    const rows: {text: string; style: string}[] = [];
    if (description.diff && !state.expanded) {
      const changes = reviewLines(description.diff);
      const digits = Math.max(2, ...changes.map(line => String(line.old ?? line.next ?? '').length));
      for (const line of changes) {
        const marker = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' ';
        const number = String(line.kind === 'add' ? line.next ?? '' : line.old ?? '').padStart(digits);
        const prefix = line.kind === 'hunk' ? '  ' : `${number} ${marker} `;
        const style = line.kind === 'add' ? this.palette.s('48;5;22;38;5;120') : line.kind === 'remove'
          ? this.palette.s('48;5;52;38;5;210') : line.kind === 'hunk' ? s.muted : s.text;
        wrapText(line.text, Math.max(1, inner - visibleWidth(prefix))).forEach((text, i) =>
          rows.push({text: (i ? ' '.repeat(visibleWidth(prefix)) : prefix) + text, style}));
      }
    } else {
      const detail = description.diff || (state.expanded ? description.details : description.command || description.summary.join('\n'));
      wrapText(detail, inner).forEach(text => rows.push({text, style: s.text}));
    }
    const capacity = Math.max(1, frame.height - (description.file ? 14 : 13)); this.dialogPageHeight = capacity;
    this.dialogScroll = Math.min(this.dialogScroll, Math.max(0, rows.length - capacity));
    const visible = rows.slice(this.dialogScroll, this.dialogScroll + capacity);
    visible.forEach((line, i) => { frame.fill(4 + i, left, width, 1, line.style); frame.text(4 + i, left, line.text, line.style, width); });
    let row = 4 + visible.length;
    frame.text(row++, left, '─'.repeat(width), s.border, width);
    if (rows.length > capacity) frame.text(row++, left, `内容 ${this.dialogScroll + 1}–${this.dialogScroll + visible.length}/${rows.length} 行 · 滚轮 / PgUp PgDn 查看全文`, s.muted, width);
    else row++;
    frame.text(row++, left, description.file ? `是否将以上修改写入 ${description.file}？` : '是否执行此次操作？', s.text, width);
    const options = description.file ? ['同意，仅此次修改', '同意，本会话允许文件编辑（Shift+Tab）', '拒绝'] : ['同意，仅执行此次操作', '拒绝'];
    options.forEach((label, index) => {
      const style = state.selected === index ? s.selected : s.text;
      frame.fill(row, left, width, 1, style);
      frame.text(row++, left, `${state.selected === index ? '❯' : ' '} ${index + 1}. ${label}`, style, width);
    });
    frame.text(Math.min(frame.height - 1, row + 1), left, `↑↓ 选择 · Enter 确认 · Esc 拒绝 · Tab ${state.expanded ? '返回审阅' : description.file ? '原始差异' : '完整参数'}`, s.muted, width);
    frame.cursor = undefined;
  }
  private connectionDialog(frame: Frame): void {
    const state = this.connection!;
    const width = Math.min(88, frame.width - 4), height = Math.min(18, frame.height - 2);
    const top = Math.floor((frame.height - height) / 2), left = Math.floor((frame.width - width) / 2), inner = width - 6;
    const s = this.styles, panelAccent = this.palette.s('48;5;233;38;5;75');
    this.box(frame, top, left, width, height, '连接模型 · Base URL & API key');
    const labels = ['Base URL', 'API key（隐藏输入）', '接口协议'];
    for (let field = 0; field < 3; field++) {
      const row = top + 3 + field * (height >= 16 ? 3 : 2), active = state.field === field;
      frame.text(row, left + 2, `${active ? '❯' : ' '} ${labels[field]}`, active ? panelAccent : s.panel, inner);
      let value: string;
      if (field === 2) value = `${state.fields.provider === 'openai' ? '●' : '○'} OpenAI 兼容    ${state.fields.provider === 'anthropic' ? '●' : '○'} Anthropic`;
      else {
        const raw = active ? this.buffer.join('') : field === 0 ? state.fields.base_url : state.fields.api_key;
        value = field === 1 ? '•'.repeat(chars(raw).length) : raw;
        if (!value) value = field === 0 ? 'https://你的模型服务地址/v1（留空使用官方地址）'
          : state.defaults.has_key && state.fields.provider === state.defaults.provider ? '留空保留已有密钥' : '输入你的 API key';
      }
      const input = active && field < 2 ? this.inputLines(inner - 2, field === 1) : undefined;
      const line = input && this.buffer.length ? input.lines[input.row] : value;
      frame.text(row + 1, left + 4, line, active ? s.selected : s.panel, inner - 2);
      if (active && field < 2) frame.cursor = {row: row + 1, column: left + 4 + (input?.column || 0)};
    }
    if (height >= 14) frame.text(top + height - 4, left + 3, state.error || '[ 连接并获取模型列表 ]', state.error ? s.error : state.field === 3 ? s.selected : panelAccent, inner);
    frame.text(top + height - 2, left + 3, 'Enter 下一步 / 连接 · Tab 切换 · ←→ 协议 · Esc 取消', s.panel, inner);
  }
  private frame(): Frame {
    const width = Math.max(1, Math.min(500, (this.target.columns || 88) - 1)), height = Math.max(1, Math.min(200, this.target.rows || 30));
    const frame = new Frame(width, height, this.styles.base), config = this.config;
    if (this.pending?.approval && this.approvalState && width >= 34 && height >= 14) { this.approvalDialog(frame); return frame; }
    if (width < 34 || height < 14) {
      frame.text(0, 0, 'EdaCode · 请放大终端窗口', this.styles.text);
      if (this.pending?.approval && this.approvalState) {
        frame.text(Math.min(1, height - 1), 0, '操作审批 · 放大窗口查看详情', this.styles.muted);
        (this.approvalState.description.file ? ['同意，仅此次', '本会话允许文件编辑', '拒绝'] : ['同意，仅此次', '拒绝']).forEach((label, i) => frame.text(Math.min(2 + i, height - 1), 0,
          `${this.approvalState!.selected === i ? '❯' : ' '} ${label}`, this.styles.text));
        frame.text(Math.min(5, height - 1), 0, '↑↓ 选择 · Enter 确认', this.styles.muted);
        return frame;
      }
      frame.text(Math.min(2, height - 1), 0, this.pending?.secret ? 'API key（隐藏输入）' : this.pending?.prompt || 'Ctrl-C 退出', this.styles.muted);
      const input = this.inputLines(width, !!this.pending?.secret);
      frame.text(Math.min(4, height - 1), 0, input.lines.at(-1) || '', this.styles.text);
      if (this.pending) frame.cursor = {row: Math.min(4, height - 1), column: Math.min(width - 1, input.column)};
      return frame;
    }
    const inputHeight = Math.min(6, Math.max(3, this.inputLines(Math.max(1, width - 13)).lines.length + 2));
    const inputTop = height - inputHeight - 2, contentBottom = inputTop - 2;
    const split = width >= 110 && contentBottom >= 23;
    const sidebarWidth = Math.min(44, Math.floor(width * 0.33));
    const leftWidth = split ? width - sidebarWidth - 8 : width - 4;
    const contentTop = this.hero(frame, 2, leftWidth);
    this.transcript(frame, contentTop + 1, 2, leftWidth, Math.max(1, contentBottom - contentTop - 1));
    if (split) this.sidebar(frame, width - sidebarWidth - 2, sidebarWidth, contentBottom);
    frame.text(inputTop - 2, 2, this.scrollInfo, this.styles.accent, leftWidth);
    const elapsed = this.workingSince === undefined ? '' : `${Math.floor((Date.now() - this.workingSince) / 1000)}s`;
    const notice = elapsed ? `◦ ${this.activityLabel}（${elapsed} · Ctrl-C 中断）` : this.notice;
    frame.text(inputTop - 1, 2, notice.split('\n')[0], this.styles.muted, width - 4);
    this.composer(frame, inputTop, 2, width - 4, inputHeight);
    const footer = `${config?.mode || 'edit'} | Enter 发送 · Ctrl+P 命令 · Ctrl+O ${this.expandedLog ? '收起' : '执行详情'} · Ctrl+Home/End 首尾`;
    frame.text(height - 1, 2, footer, this.styles.muted, width - 4);
    if (split) frame.text(inputTop - 2, width - sidebarWidth - 2, '¹ 普通文件，排除依赖与状态目录', this.styles.muted, sidebarWidth);
    this.dialog(frame);
    if (this.pending?.main && !this.commandMenu) this.mentionMenu(frame, inputTop);
    return frame;
  }
  snapshot(): string[] { return this.frame().plain(); }
  draw(): void {
    if (this.closed) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.target.write(this.frame().ansi(this.palette.reset));
  }
  close(): void {
    if (this.closed) return; this.closed = true; this.inspection?.abort(); this.resetFileMenu();
    if (this.timer) clearTimeout(this.timer);
    if (this.escapeTimer) clearTimeout(this.escapeTimer);
    clearInterval(this.statusTimer);
    clearInterval(this.progressTimer);
    const pending = this.pending; this.pending = undefined; this.buffer = []; this.history = []; this.details = ''; this.menuDraft = undefined;
    if (this.connection) this.connection.fields.api_key = '';
    this.source.removeListener('data', this.inputData); this.source.removeListener('end', this.end); this.target.removeListener('resize', this.resize);
    this.keyboard.removeListener('keypress', this.keypress); this.keyboard.destroy(); this.rawInput = '';
    process.removeListener('exit', this.exit);
    this.source.setRawMode(this.wasRaw); this.source.pause();
    this.target.write(this.palette.reset + '\x1b[?1006l\x1b[?1000l\x1b[?2004l\x1b[?25h\x1b[?1049l');
    pending?.resolve(undefined);
  }
}
