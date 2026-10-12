import test from 'node:test';
import assert from 'node:assert/strict';
import { describeApproval } from '../dist/approval.js';

test('截图中的复合 Shell 命令解释为中文步骤，完整命令不丢失', () => {
  const command = 'cd /project && grep -n "ecd_station\\|def main\\|INSERT\\|argparse\\|def .*(" spiders/ecd.py | tail -50 && echo "=== git ===" && git status --short | head -20 && git log --oneline | head -10 && echo "=== branch ===" && git branch -a && git remote -v';
  const info = describeApproval('shell', JSON.stringify({command}), '/project');
  assert.equal(info.title, '运行终端命令'); const text = info.summary.join('\n');
  for (const expected of ['工作目录：/project', '搜索文件 spiders/ecd.py', 'ecd_station', '查看当前未提交的文件改动', '查看提交记录', '查看本地或远程分支列表', '查看配置的远程仓库地址', '末尾 50 行', '开头 20 行', '开头 10 行']) assert.ok(text.includes(expected), expected);
  assert.ok(!text.includes('"command"')); assert.ok(info.details.includes(command));
});
test('命令引用中的分隔符不会变成另一项操作，动态或复杂命令不误称只读', () => {
  const quoted = describeApproval('shell', JSON.stringify({command: 'grep "git push && rm -rf" notes.txt'}));
  assert.equal(quoted.summary.length, 1); assert.ok(!quoted.summary.some(line => line.startsWith('删除') || line.startsWith('向远程')));
  for (const command of ['echo $(python3 task.py)', 'cat config > output', 'for f in *; do rm "$f"; done', 'eval "git push"']) {
    const info = describeApproval('shell', JSON.stringify({command}));
    assert.match(info.summary.join('\n'), /动态语法、重定向或复杂逻辑/); assert.ok(info.details.includes(command));
    assert.ok(!info.summary.join('\n').includes('不会修改'));
  }
});
test('写文件审批说明目标和增删行数，并保留完整差异', () => {
  const diff = '--- /dev/null\n+++ src/你好.ts\n@@ -0,0 +1,2 @@\n+const n = 1;\n+export { n };';
  const info = describeApproval('write_file', diff);
  assert.match(info.summary.join('\n'), /创建文件：src\/你好.ts/); assert.match(info.summary.join('\n'), /新增 2 行，删除 0 行/);
  assert.ok(info.details.includes(diff));
});
test('外部服务与工具解释进程或参数的用途，不对未知工具承诺安全', () => {
  const info = describeApproval('mcp_start', JSON.stringify({server: 'files', command: 'node', args: ['server.js']}));
  assert.equal(info.title, '启动外部工具服务'); assert.match(info.summary.join('\n'), /服务名称：files/); assert.match(info.summary.join('\n'), /启动外部进程/);
  const unknown = describeApproval('mcp_remote_remove', '{"id":2}');
  assert.match(unknown.summary.join('\n'), /具体行为由工具实现/); assert.match(unknown.details, /"id":2/);
});
test('修改或联网命令说明实际动作，不仅显示执行 shell', () => {
  for (const [command, expected] of [['git push origin main', '向远程仓库推送'], ['git commit -m fix', '创建 Git 提交'], ['rm old.txt', '删除文件'], ['python3 migrate.py', '运行 python3 脚本'], ['npm test', '会执行项目脚本']]) {
    const info = describeApproval('shell', JSON.stringify({command})); assert.ok(info.summary.join('\n').includes(expected)); assert.ok(info.details.includes(command));
  }
});
