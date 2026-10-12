import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { FullScreen, wrapText } from '../dist/tui.js';
import { Palette, visibleWidth } from '../dist/ui.js';
import { fixture as projectFixture } from './helpers.mjs';

function fixture(t, options = {}) {
  const source = new PassThrough(), target = new PassThrough();
  source.isTTY = target.isTTY = true; source.isRaw = false; target.columns = options.width || 120; target.rows = options.height || 30;
  source.setRawMode = value => { source.isRaw = value; };
  let output = ''; target.on('data', chunk => { output += chunk; });
  const screen = new FullScreen(source, target, new Palette(options.color ?? false));
  const config = {workspace: options.workspace || '/tmp/my-project', home: options.home, mode: 'edit', provider: 'openai', model: 'test-model', api_key: 'test-only-key'};
  screen.setContext(config, undefined, 'test-session');
  t.after(async () => { screen.close(); await new Promise(resolve => setImmediate(resolve)); source.destroy(); target.destroy(); });
  return {source, target, screen, config, send: value => source.write(value), text: () => screen.snapshot().join('\n'), output: () => output};
}
test('全屏使用独立缓冲区，双栏首页，底部输入固定，退出还原终端', async t => {
  const f = fixture(t), pending = f.screen.read('❯');
  assert.match(f.output(), /\x1b\[\?1049h/); assert.equal(f.source.isRaw, true);
  const rows = f.screen.snapshot(); assert.equal(rows.length, 30); assert.ok(rows.every(row => visibleWidth(row) <= 119));
  assert.match(f.text(), /Workspace: \/tmp\/my-project/); assert.match(f.text(), /v0.2.0/);
  assert.match(f.text(), /Workspace Status/); assert.match(f.text(), /Model & Tools/); assert.match(f.text(), /Recent Activity/);
  assert.ok(rows.at(-4).includes('Type a message'));
  assert.match(f.text(), /Type a message/); assert.match(f.text(), /Ctrl\+O 执行详情/);
  f.screen.close(); assert.equal(await pending, undefined); assert.equal(f.source.isRaw, false);
  assert.match(f.output(), /\x1b\[\?1049l/); assert.equal(f.source.listenerCount('keypress'), 0);
});
test('NO_COLOR 全屏保留布局控制，不输出颜色；控制字符不能注入屏幕', async t => {
  const f = fixture(t); f.screen.display('assistant', '\x1b[2Jhello\x1b]0;title\x07'); f.screen.draw();
  assert.ok(!/\x1b\[[0-9;]*m/.test(f.output())); assert.match(f.text(), /hello/);
  assert.ok(!f.output().includes('title'));
});
test('窗口大小变化、窄终端及中文 emoji 换行均不越界', async t => {
  const f = fixture(t), pending = f.screen.read('❯');
  f.send('你好👩‍💻e\u0301'.repeat(20));
  for (const [width, height] of [[133, 32], [70, 20], [36, 14], [18, 7], [1, 1]]) {
    f.target.columns = width; f.target.rows = height; f.target.emit('resize');
    const rows = f.screen.snapshot(); assert.equal(rows.length, height); assert.ok(rows.every(row => visibleWidth(row) === Math.max(1, width - 1)));
  }
  f.screen.close(); await pending;
  assert.deepEqual(wrapText('你好吗👩‍💻abc', 4), ['你好', '吗👩‍💻', 'abc']);
});
test('输入支持中文、emoji 编辑、Alt+Enter 换行和任务历史', async t => {
  const f = fixture(t);
  let pending = f.screen.read('❯'); f.send('你好👩‍💻\x7f世界\x1b\r第二行\r');
  assert.equal(await pending, '你好世界\n第二行');
  pending = f.screen.read('❯'); f.send('\x1b[A\r'); assert.equal(await pending, '你好世界\n第二行');
});
test('括号粘贴中的换行不会提前提交任务', async t => {
  const f = fixture(t), pending = f.screen.read('❯'); let complete = false;
  pending.then(() => { complete = true; });
  f.send('\x1b[200~first\n第二行\x1b[201~'); await new Promise(resolve => setImmediate(resolve)); assert.equal(complete, false);
  f.send('\r'); assert.equal(await pending, 'first\n第二行');
});
test('密钥弹窗隐藏输入，不进入历史；取消后下一条命令不受污染', async t => {
  const f = fixture(t), controller = new AbortController(); f.screen.onInterrupt = () => controller.abort(new Error('cancelled'));
  const pending = f.screen.read('API key：', controller.signal, true); f.send('private-test-secret'); f.screen.draw();
  assert.ok(!f.text().includes('private-test-secret')); assert.ok(!f.output().includes('private-test-secret'));
  assert.match(f.text(), /•/); f.send('\x03'); await assert.rejects(pending, /cancelled/);
  const next = f.screen.read('❯'); f.send('\x1b[A/status\r'); assert.equal(await next, '/status');
});
test('模型弹窗支持上下箭头、编号和模型 ID，空白或 Esc 可取消', async t => {
  const f = fixture(t);
  f.screen.display('info', '当前模型：one\n可用模型（3）：\n  1. one [当前]\n  2. two\n  3. three');
  let pending = f.screen.read('选择模型编号或输入模型 ID：'); assert.match(f.text(), /选择模型/);
  assert.ok(f.screen.snapshot().every(row => visibleWidth(row) === 119));
  f.send('\x1b[B\x1b[B\r'); assert.equal(await pending, '2');
  pending = f.screen.read('选择模型编号或输入模型 ID：'); f.send('custom-id\r'); assert.equal(await pending, 'custom-id');
  pending = f.screen.read('选择模型编号或输入模型 ID：'); f.send('\r'); assert.equal(await pending, '');
  pending = f.screen.read('选择模型编号或输入模型 ID：'); f.send('\x1b'); await new Promise(resolve => setTimeout(resolve, 550)); assert.equal(await pending, undefined);
});
test('审批内容完整保留且可翻页，确认前不提交答案', async t => {
  const f = fixture(t), detail = Array.from({length: 80}, (_, i) => '审批行 ' + i).join('\n');
  const pending = f.screen.confirmApproval('shell', detail); let settled = false; pending.then(() => { settled = true; });
  assert.match(f.text(), /是否执行此次操作/); assert.match(f.text(), /❯ 2\. 拒绝/); assert.ok(!f.text().includes('审批行 0'));
  f.send('\t'); assert.match(f.text(), /审批行 0/);
  const seen = new Set();
  for (let i = 0; i < 20; i++) { for (const match of f.text().matchAll(/审批行 (\d+)/g)) seen.add(Number(match[1])); f.send('\x1b[6~'); }
  assert.equal(seen.size, 80);
  f.send('\x1b[A'); assert.match(f.text(), /❯ 1\. 同意，仅执行此次操作/);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  f.send('\r'); assert.equal(await pending, true);
});
test('审批通过上下选择和 Enter 确认，默认拒绝，不进入任务历史', async t => {
  const f = fixture(t), detail = JSON.stringify({command: 'git status --short && git log --oneline | head -10'});
  let pending = f.screen.confirmApproval('shell', detail);
  assert.match(f.text(), /git status --short/); assert.match(f.text(), /git log --oneline/);
  assert.ok(!f.text().includes('Recent Activity')); assert.ok(!f.text().includes('Workspace Status'));
  assert.ok(!f.text().includes('"command"'));
  f.send('\r'); assert.equal(await pending, false);
  pending = f.screen.confirmApproval('shell', detail); f.send('\x1b[A\x1b[B\r'); assert.equal(await pending, false);
  pending = f.screen.confirmApproval('shell', detail); f.send('\x1b[B\r'); assert.equal(await pending, true);
  pending = f.screen.read('❯'); f.send('\x1b[A\r'); assert.equal(await pending, '');
});
test('审批 Esc 拒绝、粘贴不批准、Ctrl-C 中断，下一次审批重置', async t => {
  const f = fixture(t), detail = '{"command":"npm test"}';
  let pending = f.screen.confirmApproval('shell', detail);
  f.send('\x1b[200~y\n\x1b[A\r\x1b[201~'); await new Promise(resolve => setImmediate(resolve));
  assert.match(f.text(), /❯ 2\. 拒绝/); f.send('\r'); assert.equal(await pending, false);
  pending = f.screen.confirmApproval('shell', detail); f.send('\x1b[A\x1b'); await new Promise(resolve => setTimeout(resolve, 550)); assert.equal(await pending, false);
  const controller = new AbortController(); f.screen.onInterrupt = () => controller.abort(new Error('cancelled'));
  pending = f.screen.confirmApproval('shell', detail, controller.signal); f.send('y\x03'); await assert.rejects(pending, /cancelled/);
  pending = f.screen.confirmApproval('shell', detail); assert.match(f.text(), /❯ 2\. 拒绝/); f.send('y\r'); assert.equal(await pending, true);
});
test('文件审批可查看完整差异，终端缩放时仍保留选择', async t => {
  const f = fixture(t), diff = '--- api.ts\n+++ api.ts\n@@ -1 +1 @@\n-old\n+new';
  const pending = f.screen.confirmApproval('write_file', diff);
  assert.match(f.text(), /修改文件/); assert.match(f.text(), /api.ts/);
  assert.match(f.text(), /1 - old/); assert.match(f.text(), /1 \+ new/);
  assert.match(f.text(), /2\. 同意，本会话允许文件编辑/); assert.match(f.text(), /❯ 3\. 拒绝/);
  assert.ok(!f.text().includes('Model & Tools'));
  f.send('\t'); assert.match(f.text(), /-old/); assert.match(f.text(), /\+new/);
  for (const [width, height] of [[70, 20], [36, 14], [18, 7]]) {
    f.target.columns = width; f.target.rows = height; f.target.emit('resize');
    assert.match(f.text(), /拒绝/); assert.ok(f.screen.snapshot().every(row => visibleWidth(row) <= width - 1));
  }
  f.send('1\r'); assert.equal(await pending, true);
});
test('任务输出和流式文本留在对话区，历史可翻页，clear 返回首页', async t => {
  const f = fixture(t); f.screen.submitted('测试任务');
  f.screen.display('stream', '第一段'); f.screen.display('stream', '第二段'); f.screen.display('stream_end', '');
  assert.match(f.text(), /第一段第二段/);
  for (let i = 0; i < 50; i++) f.screen.display('info', 'history-line-' + i);
  const pending = f.screen.read('❯'); assert.match(f.text(), /history-line-49/); f.send('\x1b[5~'); assert.match(f.text(), /↓ 后文/); assert.match(f.text(), /history-line-(?:3\d|4[0-8])/);
  f.screen.submitted('/clear'); assert.match(f.text(), /Type a message/); f.screen.close(); await pending;
});
test('Ctrl-P 命令选择和 Tab 补全始终在全屏输入区操作', async t => {
  const f = fixture(t), pending = f.screen.read('❯');
  f.send('\x10model'); assert.match(f.text(), /命令/); f.send('\r\r'); assert.equal(await pending, '/model');
  const next = f.screen.read('❯'); f.send('/con\t\r'); assert.equal(await next, '/connect');
});
test('关闭命令选择时保留尚未发送的任务草稿', async t => {
  const f = fixture(t), pending = f.screen.read('❯');
  f.send('未发送的任务\x10model\x10\r'); assert.equal(await pending, '未发送的任务');
});
test('右栏与计划使用实际数据，工具结果决定完成状态，窄窗口收起右栏', async t => {
  const f = fixture(t, {width: 133, height: 32});
  const tools = {definitions: new Map([['read_file', {}], ['shell', {}], ['search', {}]]),
    store: {data: {todos: [{step: '读取代码', status: 'completed'}, {step: '修改接口', status: 'in_progress'}, {step: '运行检查', status: 'pending'}]}}};
  f.screen.setContext(f.config, tools);
  f.screen.submitted('重构接口'); f.screen.display('thinking', '模型请求 1/10…');
  f.screen.display('tool', 'read_file {"path":"api.ts"}');
  assert.match(f.text(), /○ 读取文件 api.ts/); assert.match(f.text(), /\[FS\] \[Terminal\] \[Search\]/);
  assert.ok(!f.text().includes('[Browser]')); assert.match(f.text(), /1\. ✓ 读取代码/); assert.match(f.text(), /2\. ○ 修改接口/);
  f.screen.display('result', 'read_file: file contents'); assert.match(f.text(), /✓ 读取文件 1 次/);
  f.screen.display('tool', 'shell {"command":"test"}'); f.screen.display('result', 'shell [失败]: failed');
  assert.match(f.text(), /✕ 运行终端命令.*failed/);
  f.target.columns = 90; f.target.rows = 24;
  assert.ok(!f.text().includes('Workspace Status')); assert.match(f.text(), /Plan/);
});
test('中断不会将未完成工具标记为成功，返回输入后保留计划', async t => {
  const f = fixture(t, {width: 133, height: 32});
  f.screen.submitted('执行任务'); f.screen.display('tool', 'shell {"command":"sleep 20"}');
  f.screen.finishTask(); assert.match(f.text(), /✕ 运行终端命令/);
});
test('/connect 表单直接显示 Base URL 和 API key，Enter 依次输入并提交，密钥不回显', async t => {
  const f = fixture(t), controller = new AbortController();
  const pending = f.screen.configureConnection({provider: 'openai', base_url: '', has_key: false}, controller.signal);
  assert.match(f.text(), /Base URL & API key/); assert.match(f.text(), /API key（隐藏输入）/); assert.match(f.text(), /OpenAI 兼容/);
  f.send('http://127.0.0.1:9999/v1\r'); f.send('private-form-secret'); f.screen.draw();
  assert.ok(!f.text().includes('private-form-secret')); assert.ok(!f.output().includes('private-form-secret'));
  f.send('\t\x1b[C\t\r');
  assert.deepEqual(await pending, {provider: 'anthropic', base_url: 'http://127.0.0.1:9999/v1', api_key: 'private-form-secret'});
  const next = f.screen.read('❯'); f.send('\x1b[A\r'); assert.equal(await next, '');
});
test('/connect 表单支持保存已有地址、密钥输入中断及再次打开', async t => {
  const f = fixture(t), controller = new AbortController(); f.screen.onInterrupt = () => controller.abort(new Error('cancelled'));
  const pending = f.screen.configureConnection({provider: 'openai', base_url: 'https://example.invalid/v1', has_key: true}, controller.signal);
  f.send('\rnot-saved-secret\x03'); await assert.rejects(pending, /cancelled/);
  const next = f.screen.configureConnection({provider: 'openai', base_url: 'https://example.invalid/v1', has_key: true});
  f.send('\r\r'); assert.deepEqual(await next, {provider: 'openai', base_url: 'https://example.invalid/v1', api_key: ''});
  assert.ok(!f.output().includes('not-saved-secret'));
});
test('长流式回复完成后从开头展示，翻页和首尾跳转可以读完每一行', async t => {
  const f = fixture(t, {width: 133, height: 32}); f.screen.submitted('分析项目');
  const lines = Array.from({length: 90}, (_, i) => `报告第 ${i} 行：中文证据与路径`);
  f.screen.display('stream', lines.slice(0, 45).join('\n') + '\n'); f.screen.draw();
  f.screen.display('stream', lines.slice(45).join('\n')); f.screen.display('stream_end', ''); f.screen.finishTask();
  const pending = f.screen.read('❯');
  assert.match(f.text(), /报告第 0 行/); assert.ok(!f.text().includes('报告第 89 行')); assert.match(f.text(), /↓ 后文/);
  const seen = new Set();
  for (let i = 0; i < 12; i++) {
    for (const match of f.text().matchAll(/报告第 (\d+) 行/g)) seen.add(Number(match[1]));
    f.send('\x1b[6~');
  }
  assert.equal(seen.size, 90);
  f.send('\x1b[1;5H'); assert.match(f.text(), /分析项目/); assert.match(f.text(), /报告第 0 行/);
  f.send('\x1b[1;5F'); assert.match(f.text(), /报告第 89 行/);
  f.screen.close(); await pending;
});
test('滚轮支持分包 SGR 和旧式报告，滚动数据不会混入任务或密钥输入', async t => {
  const f = fixture(t, {width: 133, height: 32}); f.screen.submitted('调查');
  f.screen.display('assistant', Array.from({length: 70}, (_, i) => `scroll-line-${i}`).join('\n'));
  const pending = f.screen.read('❯');
  f.send('\x1b[<64;10;'); f.send('10M'); assert.match(f.text(), /↓ 后文/);
  f.send('\x1b[M' + String.fromCharCode(96, 42, 42));
  f.send('hello\r'); assert.equal(await pending, 'hello');
  const secret = f.screen.read('API key', undefined, true);
  f.send('\x1b[<65;10;10M'); f.send('hidden-secret\r'); assert.equal(await secret, 'hidden-secret');
  assert.ok(!f.output().includes('hidden-secret'));
  f.screen.close(); assert.match(f.output(), /\x1b\[\?1006l\x1b\[\?1000l/);
});
test('阅读前文时新流式输出和任务完成不会强行跳回末尾', async t => {
  const f = fixture(t, {width: 133, height: 32}); f.screen.submitted('调查');
  f.screen.display('stream', Array.from({length: 60}, (_, i) => `stable-line-${i}`).join('\n')); f.screen.draw();
  f.send('\x1b[1;5H'); assert.match(f.text(), /stable-line-0/);
  f.screen.display('stream', '\nnew-last-line'); f.screen.finishTask();
  assert.match(f.text(), /stable-line-0/); assert.ok(!f.text().includes('new-last-line'));
});
test('超过 300 条活动仍能查看最早回复，恢复会话载入完整正文并从最终回复开头显示', async t => {
  const f = fixture(t, {width: 133, height: 32}); f.screen.submitted('最早任务'); f.screen.display('assistant', '最早回复');
  for (let i = 0; i < 350; i++) f.screen.display('info', 'activity-' + i);
  f.screen.draw(); f.send('\x1b[1;5H'); assert.match(f.text(), /最早回复/);
  const report = Array.from({length: 80}, (_, i) => `restored-line-${i}`).join('\n');
  const tools = {definitions: new Map(), store: {data: {messages: [{role: 'user', content: '恢复调查'}, {role: 'assistant', content: report}], todos: []}}};
  const restored = fixture(t, {width: 133, height: 32}); restored.screen.setContext(restored.config, tools, 'restored-session');
  assert.match(restored.text(), /restored-line-0/); restored.send('\x1b[1;5F'); assert.match(restored.text(), /restored-line-79/);
});
test('连续读取与模型请求默认合并为简短进度，Ctrl-O 可查看原始执行详情', async t => {
  const f = fixture(t, {width: 133, height: 32}); f.screen.submitted('分析项目');
  for (let i = 0; i < 40; i++) {
    f.screen.display('thinking', `模型请求 ${i + 1}/40…`);
    f.screen.display('tool', `read_file {"path":"src/file-${i}.ts"}`);
    f.screen.display('result', 'read_file: RAW_FILE_BODY_' + i);
  }
  f.screen.display('thinking', '模型请求 40/40…');
  const text = f.text(); assert.match(text, /读取文件 40 次/); assert.match(text, /思考中…（\d+s · Ctrl-C 中断）/);
  for (const raw of ['RAW_FILE_BODY', '"path"', '模型请求 40/40', '请求模型']) assert.ok(!text.includes(raw));
  f.send('\x0f'); assert.match(f.text(), /RAW_FILE_BODY_39/);
  f.send('\x0f'); assert.ok(!f.text().includes('RAW_FILE_BODY'));
  f.screen.display('assistant', '最终结论完整保留'); f.screen.display('assistant_phase', 'final'); f.screen.finishTask();
  assert.match(f.text(), /最终结论完整保留/); assert.ok(!f.text().includes('思考中…'));
});
test('中间进度折叠为两行，最终回复保持完整且可展开旧进度', async t => {
  const f = fixture(t, {width: 133, height: 32}); f.screen.submitted('调查');
  f.screen.display('stream', Array.from({length: 10}, (_, i) => '进度说明第 ' + i + ' 行').join('\n'));
  f.screen.display('stream_end', ''); f.screen.display('assistant_phase', 'progress');
  f.screen.display('tool', 'read_file {"path":"a.ts"}'); f.screen.display('result', 'read_file: body');
  f.screen.display('assistant', '最终回复第一行\n最终回复第二行\n最终回复第三行'); f.screen.display('assistant_phase', 'final'); f.screen.finishTask();
  assert.ok(!f.text().includes('进度说明第 9 行')); assert.match(f.text(), /最终回复第三行/);
  f.send('\x0f\x1b[1;5H'); assert.match(f.text(), /进度说明第 9 行/);
});
test('差异审批直接显示红绿行号，Shift-Tab 只选中本会话文件授权，Enter 才提交', async t => {
  const f = fixture(t, {color: true});
  f.screen.submitted('无关的背景任务'); f.screen.display('tool', 'shell {"command":"background-json"}');
  const diff = '--- main.py\n+++ main.py\n@@ -1,2 +1,2 @@\n-for i in range(1, 101):\n-    print(i)\n+for i in range(100):\n+    print("*")\n';
  const pending = f.screen.confirmApproval('write_file', diff); let resolved = false; pending.then(() => { resolved = true; });
  const text = f.text(); assert.match(text, /1 - for i/); assert.match(text, /2 \+     print/);
  for (const unrelated of ['无关的背景任务', 'background-json', 'Recent Activity', 'Workspace Status', '新增 2 行']) assert.ok(!text.includes(unrelated));
  f.screen.draw(); assert.match(f.output(), /48;5;22/); assert.match(f.output(), /48;5;52/);
  f.send('\x1b[Z'); assert.match(f.text(), /❯ 2\. 同意，本会话允许文件编辑/);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(resolved, false);
  f.send('\r'); assert.equal(await pending, 'session_edits');
});

async function waitForFiles(f, expected) {
  for (let i = 0; i < 100; i++) {
    const text = f.text();
    if (!text.includes('正在查找工作区文件') && text.includes(expected)) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('文件菜单未就绪：' + f.text());
}
test('@ 文件菜单模糊搜索、上下选择、Enter 仅插入引用，支持多文件与空格路径', async t => {
  const p = await projectFixture(t); p.write('src/UserService.ts', 'source'); p.write('文档/使用 说明.md', 'doc');
  const f = fixture(t, {workspace: p.root, home: p.config.home});
  const pending = f.screen.read('❯'); let submitted = false; pending.then(() => { submitted = true; });
  f.send('分析 @'); await waitForFiles(f, 'src/UserService.ts'); assert.match(f.text(), /文档\/使用 说明.md/);
  f.send('usvc'); await waitForFiles(f, 'src/UserService.ts'); assert.ok(!f.text().includes('文档/使用 说明.md'));
  f.send('\r'); await new Promise(resolve => setImmediate(resolve)); assert.equal(submitted, false);
  assert.ok(!f.text().includes('引用文件')); assert.match(f.text(), /分析 @src\/UserService.ts/);
  f.send('以及 @'); await waitForFiles(f, '引用文件'); f.send('\x1b[B\t');
  assert.match(f.text(), /@"文档\/使用 说明.md"/);
  f.send('\r'); assert.equal(await pending, '分析 @src/UserService.ts 以及 @"文档/使用 说明.md" ');
});
test('@ 菜单取消保留草稿，不匹配时 Enter 不发送；email 和密钥不触发菜单', async t => {
  const p = await projectFixture(t); p.write('main.ts', 'source');
  const f = fixture(t, {workspace: p.root, home: p.config.home}); let pending = f.screen.read('❯');
  f.send('me@example.com'); assert.ok(!f.text().includes('引用文件'));
  f.send(' @missing'); await waitForFiles(f, '没有匹配文件'); f.send('\r');
  assert.match(f.text(), /引用文件/);
  f.send('\x1b'); await new Promise(resolve => setTimeout(resolve, 550)); assert.ok(!f.text().includes('引用文件'));
  f.send('\r'); assert.equal(await pending, 'me@example.com @missing');
  pending = f.screen.read('API key', undefined, true); f.send('@secret'); assert.ok(!f.text().includes('引用文件')); f.send('\r'); assert.equal(await pending, '@secret');
});
test('@ 菜单重新打开发现新文件，窄窗口可选择；粘贴不会提交，编辑中间词保留后文', async t => {
  const p = await projectFixture(t); p.write('main.ts', 'source');
  const f = fixture(t, {workspace: p.root, home: p.config.home, width: 70, height: 20}); const pending = f.screen.read('❯');
  f.send('@'); await waitForFiles(f, 'main.ts'); f.send('\x1b'); await new Promise(resolve => setTimeout(resolve, 550));
  p.write('new file.ts', 'new');
  f.send('\x15\x1b[200~检查 @nf 后文\x1b[201~'); assert.ok(!f.text().includes('引用文件'));
  f.send('\x1b[D\x1b[D\x1b[D'); await waitForFiles(f, 'new file.ts');
  assert.ok(f.screen.snapshot().every(row => visibleWidth(row) === 69));
  f.send('\r'); assert.ok(!f.text().includes('引用文件')); f.send('\r');
  assert.equal(await pending, '检查 @"new file.ts" 后文');
});
