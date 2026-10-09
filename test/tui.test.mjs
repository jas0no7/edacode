import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { FullScreen, wrapText } from '../dist/tui.js';
import { Palette, visibleWidth } from '../dist/ui.js';

function fixture(t, options = {}) {
  const source = new PassThrough(), target = new PassThrough();
  source.isTTY = target.isTTY = true; source.isRaw = false; target.columns = options.width || 120; target.rows = options.height || 30;
  source.setRawMode = value => { source.isRaw = value; };
  let output = ''; target.on('data', chunk => { output += chunk; });
  const screen = new FullScreen(source, target, new Palette(options.color ?? false));
  const config = {workspace: '/tmp/my-project', mode: 'edit', provider: 'openai', model: 'test-model', api_key: 'test-only-key'};
  screen.setContext(config, undefined, 'test-session');
  t.after(async () => { screen.close(); await new Promise(resolve => setImmediate(resolve)); source.destroy(); target.destroy(); });
  return {source, target, screen, config, send: value => source.write(value), text: () => screen.snapshot().join('\n'), output: () => output};
}
test('全屏使用独立缓冲区，首页居中，底部状态固定，退出还原终端', async t => {
  const f = fixture(t), pending = f.screen.read('❯');
  assert.match(f.output(), /\x1b\[\?1049h/); assert.equal(f.source.isRaw, true);
  const rows = f.screen.snapshot(); assert.equal(rows.length, 30); assert.ok(rows.every(row => visibleWidth(row) <= 119));
  assert.ok(rows.at(-1).includes('/tmp/my-project')); assert.ok(rows.at(-1).includes('0.2.0'));
  assert.match(f.text(), /随便说点什么/); assert.match(f.text(), /edit · test-model/);
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
    const rows = f.screen.snapshot(); assert.equal(rows.length, height); assert.ok(rows.every(row => visibleWidth(row) <= Math.max(1, width - 1)));
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
  f.send('\x1b[B\x1b[B\r'); assert.equal(await pending, '2');
  pending = f.screen.read('选择模型编号或输入模型 ID：'); f.send('custom-id\r'); assert.equal(await pending, 'custom-id');
  pending = f.screen.read('选择模型编号或输入模型 ID：'); f.send('\r'); assert.equal(await pending, '');
  pending = f.screen.read('选择模型编号或输入模型 ID：'); f.send('\x1b'); await new Promise(resolve => setTimeout(resolve, 550)); assert.equal(await pending, undefined);
});
test('审批内容完整保留且可翻页，确认前不提交答案', async t => {
  const f = fixture(t), detail = Array.from({length: 80}, (_, i) => '审批行 ' + i).join('\n');
  f.screen.approval('shell', detail); const pending = f.screen.read('允许此次操作？[y/N]');
  assert.match(f.text(), /操作审批/); assert.match(f.text(), /审批行 0/);
  f.send('\x1b[6~'); assert.ok(!f.text().includes('审批行 0')); f.send('y\r'); assert.equal(await pending, 'y');
});
test('任务输出和流式文本留在对话区，历史可翻页，clear 返回首页', async t => {
  const f = fixture(t); f.screen.submitted('测试任务');
  f.screen.display('stream', '第一段'); f.screen.display('stream', '第二段'); f.screen.display('stream_end', '');
  assert.match(f.text(), /第一段第二段/);
  for (let i = 0; i < 50; i++) f.screen.display('info', 'history-line-' + i);
  const pending = f.screen.read('❯'); assert.match(f.text(), /history-line-49/); f.send('\x1b[5~'); assert.match(f.text(), /历史/);
  f.screen.submitted('/clear'); assert.match(f.text(), /随便说点什么/); f.screen.close(); await pending;
});
test('Ctrl-P 命令选择和 Tab 补全始终在全屏输入区操作', async t => {
  const f = fixture(t), pending = f.screen.read('❯');
  f.send('\x10model'); assert.match(f.text(), /命令/); f.send('\r\r'); assert.equal(await pending, '/model');
  const next = f.screen.read('❯'); f.send('/con\t\r'); assert.equal(await next, '/connect');
});
