import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { fixture as createFixture } from './helpers.mjs';
import { connectModel } from '../dist/connection.js';
import { loadConfig } from '../dist/config.js';
import { Provider } from '../dist/providers.js';
import { Input } from '../dist/cli.js';
import { ModelCatalog } from '../dist/models.js';

async function fixture(...args) {
  const f = await createFixture(...args);
  f.engine.modelCatalog = new ModelCatalog(async () => []);
  return f;
}

test('隐藏输入不回显，完成或中断后不残留在编辑缓冲、历史或 Ctrl-Y 中', async t => {
  for (const interrupt of [false, true]) {
    const source = new PassThrough(), target = new PassThrough();
    source.isTTY = target.isTTY = true; target.columns = 80; source.setRawMode = () => {};
    let output = ''; target.on('data', chunk => { output += chunk; });
    const input = new Input(source, target); t.after(async () => { input.close(); await new Promise(resolve => setImmediate(resolve)); source.destroy(); target.destroy(); });
    const controller = new AbortController(); input.onInterrupt = () => controller.abort(new Error('cancelled'));
    const pending = input.read('API key: ', controller.signal, true);
    source.write('fake-hidden-key');
    if (interrupt) { source.write('\x03'); await assert.rejects(pending, /cancelled/); }
    else { source.write('\r'); assert.equal(await pending, 'fake-hidden-key'); }
    const next = input.read('> ');
    source.write('\x1b[A/status\r');
    assert.equal(await next, '/status');
    const yank = input.read('> '); source.write('\x19\r');
    assert.ok(!(await yank).includes('fake-hidden-key'));
    assert.ok(!output.includes('fake-hidden-key'));
  }
});

function answers(...values) {
  const prompts = [];
  const read = async (prompt, secret) => { prompts.push({prompt, secret}); return values.shift(); };
  return {read, prompts};
}
test('向导保存全局配置并立即切换 provider，凭据不进入会话', async t => {
  const f = await fixture(t);
  f.write('.state/.env', '# existing comment\nEDACODE_TIMEOUT=45\nOPENAI_BASE_URL=https://old.example/v1\n');
  const key = 'local-only-#-$-中文-"-test';
  const input = answers('2', key, 'https://gateway.example/v1', 'my-model');
  const output = await connectModel(f.engine, input.read);
  assert.equal(f.config.provider, 'openai'); assert.equal(f.config.api_key, key);
  assert.ok(f.engine.provider instanceof Provider); assert.equal(f.engine.evaluator.provider, f.engine.provider);
  assert.equal(f.engine.provider.client, undefined, '连接不发送模型请求');
  assert.equal(input.prompts[1].secret, true);
  assert.ok(!output.includes(key)); assert.ok(!JSON.stringify(input.prompts).includes(key));
  assert.ok(!JSON.stringify(f.store.data).includes(key));
  const saved = f.read('.state/.env'); assert.match(saved, /# existing comment/); assert.match(saved, /EDACODE_TIMEOUT=45/);
  const reloaded = loadConfig({workspace: f.root, home: f.config.home}, {});
  assert.equal(reloaded.api_key, key); assert.equal(reloaded.model, 'my-model'); assert.equal(reloaded.base_url, 'https://gateway.example/v1'); assert.equal(reloaded.timeout, 45);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(f.config.home, '.env')).mode & 0o777, 0o600);
});
test('重复连接可保留已有密钥并重置 Base URL，保留另一接口配置', async t => {
  const f = await fixture(t);
  await connectModel(f.engine, answers('one-key', 'https://gateway.example/v1', 'one-model').read, 'openai');
  await connectModel(f.engine, answers('', '-', '').read, 'openai');
  assert.equal(f.config.api_key, 'one-key'); assert.equal(f.config.base_url, undefined);
  await connectModel(f.engine, answers('two-key', '', 'two-model').read, 'anthropic');
  const env = f.read('.state/.env'); assert.equal((env.match(/# BEGIN EDACODE CONNECTION/g) || []).length, 1);
  const openai = loadConfig({workspace: f.root, home: f.config.home, provider: 'openai'}, {});
  assert.equal(openai.api_key, 'one-key'); assert.equal(openai.base_url, undefined);
  assert.equal(loadConfig({workspace: f.root, home: f.config.home}, {}).api_key, 'two-key');
});
test('配置取消、错误地址、空密钥及控制字符均不修改原配置', async t => {
  const f = await fixture(t); f.write('.state/.env', '# unchanged\nEDACODE_TIMEOUT=90\n');
  const original = f.read('.state/.env'), previous = f.engine.provider;
  for (const values of [[undefined], ['key', undefined], ['key', '', undefined], ['key', 'file:///tmp', 'model'], ['', '', 'model'], ['key\ninjected', '', 'model']]) {
    await assert.rejects(connectModel(f.engine, answers(...values).read, 'openai'));
    assert.equal(f.read('.state/.env'), original); assert.equal(f.engine.provider, previous); assert.equal(f.config.provider, 'mock');
  }
});
test('向导中断不会保存或切换模型', async t => {
  const f = await fixture(t); const previous = f.engine.provider;
  await assert.rejects(connectModel(f.engine, async () => { f.engine.cancel(); return 'key'; }, 'openai'), /中断/);
  assert.equal(fs.existsSync(path.join(f.config.home, '.env')), false); assert.equal(f.engine.provider, previous);
});
test('连接后首个任务和重新连接使用新的密钥、地址与模型', async t => {
  const f = await fixture(t); const requests = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({url: req.url, auth: req.headers.authorization, body: JSON.parse(body)});
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({choices: [{message: {content: 'done'}, finish_reason: 'stop'}], usage: {prompt_tokens: 1, completion_tokens: 1}}));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  for (const index of [1, 2]) {
    await connectModel(f.engine, answers(`fake-key-${index}`, `http://127.0.0.1:${server.address().port}/v${index}`, `test-model-${index}`).read, 'openai');
    const result = await f.engine.run('hello'); assert.equal(result.status, 'completed', result.reason);
  }
  assert.deepEqual(requests.map(x => [x.url, x.auth, x.body.model]), [
    ['/v1/chat/completions', 'Bearer fake-key-1', 'test-model-1'], ['/v2/chat/completions', 'Bearer fake-key-2', 'test-model-2']]);
});
test('缺少配置时可创建引擎，模型请求之前不初始化 SDK', async t => {
  const f = await fixture(t, {config: {provider: 'anthropic', api_key: '', model: ''}});
  assert.equal(f.engine.provider.client, undefined);
  await assert.rejects(f.engine.provider.complete('', [], []), /\/connect/);
  assert.equal(f.engine.provider.client, undefined);
});
