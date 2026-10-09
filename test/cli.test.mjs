import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture } from './helpers.mjs';
import { listSessions, projectRoot } from '../dist/storage.js';
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
function launch(args, opts = {}) {
  const child = spawn(process.execPath, [cli, ...args], {stdio: ['pipe', 'pipe', 'pipe'], ...opts});
  let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve({code, stdout, stderr})); });
  return {child, done, output: () => ({stdout, stderr})};
}
test('无模型配置即可查询 help 和 version', async () => {
  for (const flag of ['--help', '--version']) { const run = launch([flag], {env: {...process.env, EDACODE_MODEL: '', MODEL_ID: '', ANTHROPIC_API_KEY: ''}}); run.child.stdin.end(); const result = await run.done; assert.equal(result.code, 0); assert.match(result.stdout, /0\.2\.0/); }
});
test('任意目录直接启动，管道多个命令不丢失', async t => {
  const f = await fixture(t); f.write('project-marker', 'marker');
  const run = launch(['--provider', 'mock', '--home', f.config.home, '--no-banner'], {cwd: f.root, env: {...process.env, NO_COLOR: '1'}});
  run.child.stdin.end('/status\n列出文件\n/quit\n'); const result = await run.done;
  assert.equal(result.code, 0, result.stderr); assert.ok(result.stdout.includes(f.root)); assert.match(result.stdout, /project-marker/); assert.ok(!result.stdout.includes('\x1b'));
});
test('单次 JSON 只有一个对象，工作区可显式覆盖', async t => {
  const f = await fixture(t); f.write('marker', 'data');
  const run = launch(['--provider', 'mock', '--home', f.config.home, '--workspace', f.root, '--json', '-p', '列出文件'], {cwd: path.dirname(f.root)});
  run.child.stdin.end(); const result = await run.done; assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, ''); const json = JSON.parse(result.stdout); assert.equal(json.status, 'completed'); assert.match(json.text, /marker/); assert.ok(json.usage);
});
test('启动配置失败输出 JSON 与退出码 2', async t => {
  const f = await fixture(t); const run = launch(['--provider', 'anthropic', '--home', f.config.home, '--workspace', f.root, '--json', '-p', '任务'],
    {env: {...process.env, ANTHROPIC_API_KEY: '', EDACODE_MODEL: '', MODEL_ID: ''}});
  run.child.stdin.end(); const result = await run.done; assert.equal(result.code, 2); assert.equal(JSON.parse(result.stdout).status, 'error'); assert.equal(result.stderr, '');
});
test('无密钥可进入 CLI、查看状态，未连接任务和非 TTY 向导不终止会话', async t => {
  const f = await fixture(t);
  const run = launch(['--provider', 'anthropic', '--home', f.config.home, '--no-banner'],
    {cwd: f.root, env: {...process.env, ANTHROPIC_API_KEY: '', EDACODE_MODEL: '', MODEL_ID: '', NO_COLOR: '1'}});
  run.child.stdin.end('/status\nhello\n/connect\n/help\n/quit\n');
  const result = await run.done;
  assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /未配置/);
  assert.ok(result.stdout.includes(f.root)); assert.match(result.stderr, /\/connect/); assert.match(result.stderr, /交互式终端/);
  assert.match(result.stderr, /配置 API key、Base URL 和模型/); assert.equal(fs.existsSync(path.join(f.config.home, '.env')), false);
});
test('非 TTY 输入不会因审批而执行 shell 注入', async t => {
  const f = await fixture(t); f.write('.edacode/commands/probe.md', '!{echo must-not-run > should-not-exist}');
  const run = launch(['--provider', 'mock', '--home', f.config.home, '--mode', 'ask', '--no-banner'], {cwd: f.root}); run.child.stdin.end('/probe\n/quit\n');
  const result = await run.done; assert.equal(result.code, 0); assert.equal(fs.existsSync(path.join(f.root, 'should-not-exist')), false);
  const session = listSessions(f.config).find(s => s.id !== f.store.id);
  const data = JSON.parse(fs.readFileSync(path.join(projectRoot(f.config), 'sessions', session.id, 'session.json'), 'utf8'));
  assert.match(data.messages[0].content, /未批准 shell/);
});
test('EOF 和多行输入可正常退出', async t => {
  const f = await fixture(t); const run = launch(['--provider', 'mock', '--home', f.config.home, '--no-banner'], {cwd: f.root}); run.child.stdin.end('第一行\\\n第二行\n'); const result = await run.done;
  assert.equal(result.code, 0); assert.match(result.stdout, /离线演示完成/);
});
test('SIGINT 取消真实模型请求，单次 JSON 退出码为 130', {skip: process.platform === 'win32', timeout: 10000}, async t => {
  const {createServer} = await import('node:http'); const {once} = await import('node:events'); const f = await fixture(t);
  let requested; const pending = new Promise(resolve => { requested = resolve; });
  const server = createServer((req, res) => { req.resume(); requested(); }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const run = launch(['--provider', 'openai', '--home', f.config.home, '--workspace', f.root, '--json', '-p', '等待响应'],
    {env: {...process.env, OPENAI_API_KEY: 'local-only', EDACODE_MODEL: 'local-model', OPENAI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`}});
  t.after(() => { if (run.child.exitCode === null) run.child.kill('SIGKILL'); });
  await pending; run.child.kill('SIGINT'); const result = await run.done; assert.equal(result.code, 130, result.stderr); assert.equal(JSON.parse(result.stdout).status, 'cancelled'); assert.equal(result.stderr, '');
});
