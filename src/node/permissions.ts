import type { Confirm, Mode } from './types.js';
const READ = new Set(['read_file', 'list_files', 'search', 'load_skill', 'read_artifact', 'job_status', 'update_plan', 'delegate']);
const WRITE = new Set(['write_file', 'edit_file']);
export function checkCommand(command: string): void {
  const text = command.toLowerCase().replace(/\s+/g, ' ').trim();
  if (['rm -rf /', 'sudo ', 'shutdown', 'reboot', 'mkfs', 'dd if=', ':(){ :|:& };:'].some(item => text.includes(item))) {
    throw new Error('命令命中 EdaCode 硬拒绝规则，未执行');
  }
}
export class Policy {
  constructor(public mode: Mode = 'edit', public confirm: Confirm = () => false) {
    if (!['plan', 'ask', 'edit', 'auto'].includes(mode)) throw new Error('无效权限模式');
  }
  async authorize(name: string, detail = ''): Promise<void> {
    if (READ.has(name)) return;
    if (this.mode === 'plan') throw new Error(`plan 模式禁止 ${name}；请由用户通过 /mode 切换`);
    if (this.mode === 'auto' || (this.mode === 'edit' && WRITE.has(name))) return;
    if (!await this.confirm(name, detail)) throw new Error(`用户未批准 ${name}；请调整方案，不要重复相同调用`);
  }
}
