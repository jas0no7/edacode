import { safeTerminal } from './ui.js';

export interface ApprovalDescription { title: string; summary: string[]; details: string; file?: string; diff?: string; command?: string }
/** 只解析显示文字，不执行命令，也不据此放宽权限。遇到动态语法不声称只读。 */
function shellSteps(command: string): string[] {
  const parts: string[][] = []; let words: string[] = [], word = '', quote = '', active = false;
  const flushWord = () => { if (active) words.push(word); word = ''; active = false; };
  const flush = () => { flushWord(); if (words.length) parts.push(words); words = []; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = '';
      else if (c === '\\' && quote === '"' && /["\\$`\n]/.test(command[i + 1] || '')) word += command[++i];
      else word += c;
    } else if (c === '"' || c === "'") { quote = c; active = true; }
    else if (c === '\\' && i + 1 < command.length) { word += command[++i]; active = true; }
    else if (';|&\n'.includes(c)) flush();
    else if (/\s/.test(c)) flushWord();
    else { word += c; active = true; }
  }
  flush();
  const steps: string[] = [];
  for (const [bin, ...args] of parts) {
    if (bin === 'echo' || bin === 'printf') continue;
    if (bin === 'cd') steps.push(`切换工作目录：${args.join(' ')}`);
    else if (bin === 'grep' || bin === 'rg') {
      const values = args.filter(arg => !arg.startsWith('-'));
      steps.push(`搜索${values.length > 1 ? '文件 ' + values.slice(1).join('、') : '文件内容'}，匹配：${values[0] || '见原始命令'}`);
    } else if (bin === 'git') {
      const action = args[0];
      const labels: Record<string, string> = {status: '查看当前未提交的文件改动', log: '查看提交记录', diff: '查看代码差异', show: '查看提交或文件内容',
        push: '向远程仓库推送提交', fetch: '从远程仓库获取提交', pull: '从远程仓库获取并合并代码', commit: '创建 Git 提交',
        add: '将文件加入 Git 暂存区', reset: '重置 Git 状态，可能丢弃改动', clean: '清理未跟踪文件，可能删除文件',
        checkout: '切换分支或恢复文件', switch: '切换 Git 分支', restore: '恢复文件或暂存区内容'};
      if (action === 'branch') steps.push(args.every(arg => ['branch', '-a', '-r', '-v', '-vv', '--all', '--list', '--show-current'].includes(arg))
        ? '查看本地或远程分支列表' : '操作 Git 分支（具体参数见原始命令）');
      else if (action === 'remote') steps.push(args.length === 1 || (args.length === 2 && args[1] === '-v')
        ? '查看配置的远程仓库地址' : '修改或查询 Git 远程仓库配置');
      else steps.push(labels[action] || `执行 Git 命令：${args.join(' ')}`);
    } else if (bin === 'head' || bin === 'tail') {
      const count = args.find(arg => /^-\d+$/.test(arg))?.slice(1) || args[args.indexOf('-n') + 1] || '10';
      steps.push(`显示${bin === 'head' ? '开头' : '末尾'} ${/^\d+$/.test(count) ? count : '指定数量的'} 行`);
    } else if (['npm', 'pnpm', 'yarn', 'bun'].includes(bin)) steps.push(`运行项目命令：${[bin, ...args].join(' ')}（会执行项目脚本或包管理操作）`);
    else if (['python', 'python3', 'node', 'bash', 'sh', 'zsh', 'powershell', 'pwsh'].includes(bin)) steps.push(`运行 ${bin} 脚本或代码，具体行为见原始命令`);
    else if (['rm', 'del', 'rmdir'].includes(bin)) steps.push(`删除文件或目录：${args.join(' ')}`);
    else if (bin === 'cp') steps.push(`复制文件或目录：${args.join(' ')}`);
    else if (bin === 'mv') steps.push(`移动或重命名文件：${args.join(' ')}`);
    else if (bin === 'mkdir') steps.push(`创建目录：${args.join(' ')}`);
    else steps.push(`运行命令：${[bin, ...args].join(' ')}`);
  }
  if (quote || /[$`<>\r]/.test(command) || parts.some(([bin]) => ['if', 'for', 'while', 'eval', 'source', '.'].includes(bin))) {
    steps.push('包含动态语法、重定向或复杂逻辑，可能读写文件或联网；请展开原始命令核对。');
  }
  return steps.length ? steps : ['运行终端命令，具体内容见原始命令。'];
}
export function describeApproval(name: string, detail: string, workspace?: string): ApprovalDescription {
  name = safeTerminal(name); detail = safeTerminal(detail);
  let args: any; try { args = JSON.parse(detail); } catch { /* 文件写入是完整 diff。 */ }
  if (name === 'shell' && typeof args?.command === 'string') return {title: '运行终端命令',
    command: args.command,
    summary: [...(workspace ? [`工作目录：${workspace}`] : []), ...shellSteps(args.command)],
    details: `原始命令：\n${args.command}\n\n完整参数：\n${detail}`};
  if (name === 'write_file' || name === 'edit_file') {
    const file = detail.match(/^\+\+\+ (.+?)(?:\t|$)/m)?.[1] || args?.path || '见完整差异';
    const lines = detail.split('\n');
    return {title: '修改文件', file, diff: detail, summary: [`${/^--- \/dev\/null$/m.test(detail) ? '创建' : '修改'}文件：${file}`,
      `新增 ${lines.filter(line => /^\+(?!\+\+)/.test(line)).length} 行，删除 ${lines.filter(line => /^-(?!--)/.test(line)).length} 行。`,
      '同意后将写入磁盘；可展开查看完整差异。'], details: `完整文件差异：\n${detail}`};
  }
  if (name === 'mcp_start') return {title: '启动外部工具服务', summary: [`服务名称：${args?.server || '见完整参数'}`,
    `启动程序：${args?.command || '见完整参数'}`, '同意后将启动外部进程，为 agent 提供工具。'], details: `完整启动参数：\n${detail}`};
  return {title: '调用外部工具', summary: [`工具：${name}`, '同意后将把参数交给该工具；具体行为由工具实现。'], details: `完整调用参数：\n${detail}`};
}
