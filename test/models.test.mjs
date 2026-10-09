import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers.mjs';
import { discoverModels, ModelCatalog } from '../dist/models.js';
import { connectModel, chooseModel } from '../dist/connection.js';
import { command, Input } from '../dist/cli.js';
import { loadConfig, normalizeBaseURL } from '../dist/config.js';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

async function serve(t, handler) {
  const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
const json = (res, data) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data)); };
const answers = (...values) => async () => values.shift();

for (const provider of ['openai', 'anthropic']) test(`${provider} 模型发现仅需凭据，使用正确路径和认证并过滤重复或无效 ID`, async t => {
  const requests = [];
  const base = await serve(t, (req, res) => {
    requests.push({url: req.url, headers: req.headers});
    json(res, {data: [{id: 'model-a', display_name: '中文模型'}, {id: 'model-a', display_name: '中文模型'}, {id: 'model-b'}, {}, {id: 'bad\x1b[31m'}, {id: 'local-test-secret'}]});
  });
  const f = await fixture(t, {config: {provider, api_key: 'local-test-secret', model: '', base_url: base + '/v1/'}});
  assert.deepEqual(await discoverModels(f.config), [{id: 'model-a', name: '中文模型'}, {id: 'model-b'}]);
  assert.equal(requests[0].url, '/v1/models');
  assert.equal(requests[0].headers.authorization, 'Bearer local-test-secret');
  if (provider === 'anthropic') { assert.equal(requests[0].headers['x-api-key'], 'local-test-secret'); assert.equal(requests[0].headers['anthropic-version'], '2023-06-01'); }
});
test('Anthropic 自动翻页且防止重复游标形成无限请求', async t => {
  let requests = 0, loop = false;
  const base = await serve(t, (req, res) => {
    requests++;
    if (!req.url.includes('after_id')) json(res, {data: [{id: 'one'}], has_more: true, last_id: 'one'});
    else json(res, {data: [{id: 'two'}], has_more: loop, last_id: 'one'});
  });
  const f = await fixture(t, {config: {provider: 'anthropic', api_key: 'secret-only', base_url: base}});
  assert.deepEqual((await discoverModels(f.config)).map(x => x.id), ['one', 'two']); assert.equal(requests, 2);
  loop = true; await assert.rejects(discoverModels(f.config), /游标无效/);
});
test('支持中转站字符串列表和 models 字段', async t => {
  for (const payload of [['model-a'], {models: ['model-a']}]) {
    const base = await serve(t, (req, res) => json(res, payload));
    const f = await fixture(t, {config: {provider: 'openai', api_key: 'secret-only', base_url: base}});
    assert.deepEqual(await discoverModels(f.config), [{id: 'model-a'}]);
  }
});
test('根地址、v1 地址及完整接口地址归一化，模型发现和推理路径一致', () => {
  for (const value of ['https://example.test', 'https://example.test/v1/', 'https://example.test/v1/chat/completions', 'https://example.test/v1/models']) {
    assert.equal(normalizeBaseURL('openai', value), 'https://example.test/v1');
  }
  for (const value of ['https://example.test', 'https://example.test/v1/', 'https://example.test/v1/messages']) assert.equal(normalizeBaseURL('anthropic', value), 'https://example.test');
  assert.equal(normalizeBaseURL('anthropic', 'https://example.test/proxy/v1'), 'https://example.test/proxy');
  for (const value of ['file:///tmp', 'https://name:password@example.test', 'https://example.test?key=secret', 'https://example.test#fragment']) assert.throws(() => normalizeBaseURL('openai', value));
});
test('模型列表错误不展示响应中的密钥，未实现接口时保留手动选型入口', async t => {
  let status = 401;
  const base = await serve(t, (req, res) => { res.statusCode = status; res.end('secret-only credential body'); });
  const f = await fixture(t, {config: {provider: 'openai', api_key: 'secret-only', base_url: base, model: 'existing'}});
  for (const code of [401, 403, 404, 405, 429, 500]) {
    status = code;
    await assert.rejects(discoverModels(f.config), error => error.message.includes(`HTTP ${code}`) && !error.message.includes('secret-only'));
  }
  status = 404;
  assert.match(await chooseModel(f.engine, answers('manual-model')), /manual-model/);
  assert.equal(f.config.model, 'manual-model');
});
test('无效 JSON、无效格式及过大响应给出可恢复错误', async t => {
  let payload = 'html error';
  const base = await serve(t, (req, res) => res.end(payload));
  const f = await fixture(t, {config: {provider: 'openai', api_key: 'secret-only', base_url: base}});
  await assert.rejects(discoverModels(f.config), /不是有效 JSON/);
  payload = '{"unexpected":true}'; await assert.rejects(discoverModels(f.config), /格式无效/);
  payload = 'x'.repeat(2 * 1024 * 1024 + 1); await assert.rejects(discoverModels(f.config), /响应过大/);
});
test('重定向不会把凭据带到另一地址', async t => {
  let forwarded = 0;
  const other = await serve(t, (req, res) => { forwarded++; json(res, {data: []}); });
  const base = await serve(t, (req, res) => { res.writeHead(302, {Location: other + '/v1/models'}); res.end(); });
  const f = await fixture(t, {config: {provider: 'openai', api_key: 'secret-only', base_url: base}});
  await assert.rejects(discoverModels(f.config), /无法连接/); assert.equal(forwarded, 0);
});
test('超时或中断模型发现后不保存配置、不切换当前模型', async t => {
  let requested;
  const pending = new Promise(resolve => { requested = resolve; });
  const base = await serve(t, (req, res) => { req.resume(); requested(); });
  const f = await fixture(t, {config: {provider: 'openai', api_key: 'secret-only', base_url: base, timeout: 0.05, model: 'existing'}});
  await assert.rejects(discoverModels(f.config), /超时/);
  f.config.timeout = 5;
  const choosing = chooseModel(f.engine, answers('1'));
  await pending; f.engine.cancel(); await assert.rejects(choosing, /中断/);
  assert.equal(f.config.model, 'existing'); assert.equal(fs.existsSync(path.join(f.config.home, '.env')), false);
});
test('模型列表缓存按接口、密钥和地址隔离，refresh 更新且失败后不沿用编号', async () => {
  let loads = 0, fail = false;
  const catalog = new ModelCatalog(async () => { loads++; if (fail) throw new Error('failed'); return [{id: 'model-' + loads}]; });
  const config = {provider: 'openai', api_key: 'first', base_url: 'https://one.test'};
  assert.equal((await catalog.list(config))[0].id, 'model-1'); await catalog.list(config); assert.equal(loads, 1);
  await catalog.list({...config, api_key: 'second'}); assert.equal(loads, 2);
  await catalog.list({...config, base_url: 'https://two.test'}); assert.equal(loads, 3);
  await catalog.list(config, undefined, true); assert.equal(loads, 4);
  fail = true; await assert.rejects(catalog.list(config, undefined, true));
  fail = false; assert.equal((await catalog.list(config))[0].id, 'model-6');
});
test('连接自动获取模型，通过 /model 编号选择并保存，首次推理采用所选模型', async t => {
  const requests = [];
  const base = await serve(t, async (req, res) => {
    requests.push({url: req.url, auth: req.headers.authorization});
    if (req.method === 'GET') return json(res, {data: [{id: 'model-a'}, {id: 'model-b'}]});
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.at(-1).body = JSON.parse(raw);
    json(res, {choices: [{message: {content: 'done'}, finish_reason: 'stop'}]});
  });
  const f = await fixture(t); const display = []; f.engine.display = (kind, text) => display.push(text);
  await connectModel(f.engine, answers('secret-only', base + '/v1/chat/completions', ''), 'openai');
  assert.equal(f.config.model, ''); assert.equal(f.config.base_url, base + '/v1'); assert.match(display.join('\n'), /1\. model-a/);
  const listed = await command('/model list', f.config, f.store, f.engine); assert.match(listed, /2\. model-b/);
  const selected = await command('/model', f.config, f.store, f.engine, undefined, answers('2')); assert.match(selected, /model-b/);
  assert.equal(loadConfig({workspace: f.root, home: f.config.home}, {}).model, 'model-b');
  assert.equal((await f.engine.run('hello')).status, 'completed');
  assert.equal(requests.length, 2); assert.equal(requests[1].body.model, 'model-b'); assert.equal(requests[1].url, '/v1/chat/completions');
  await command('/model 1', f.config, f.store, f.engine); assert.equal(f.config.model, 'model-a');
  assert.equal((await f.engine.run('again')).status, 'completed'); assert.equal(requests[2].body.model, 'model-a');
  assert.ok(!JSON.stringify(f.store.data).includes('secret-only'));
});
test('连接时可直接按编号选型，空列表仍能手动选择', async t => {
  const f = await fixture(t);
  f.engine.modelCatalog = new ModelCatalog(async () => [{id: 'one'}, {id: 'two'}]);
  await connectModel(f.engine, answers('secret-only', '', '2'), 'openai'); assert.equal(f.config.model, 'two');
  f.engine.modelCatalog = new ModelCatalog(async () => []);
  await chooseModel(f.engine, answers('manual')); assert.equal(f.config.model, 'manual');
});
test('/model 空白取消或无效编号不修改配置，直接输入 ID 无需模型列表接口', async t => {
  const f = await fixture(t, {config: {provider: 'openai', api_key: 'secret-only', model: 'existing'}});
  f.engine.modelCatalog = new ModelCatalog(async () => [{id: 'one'}]);
  await chooseModel(f.engine, answers('')); assert.equal(f.config.model, 'existing');
  await assert.rejects(chooseModel(f.engine, answers('9')), /超出/); assert.equal(f.config.model, 'existing');
  f.engine.modelCatalog = new ModelCatalog(async () => { throw new Error('must not query'); });
  await chooseModel(f.engine, undefined, 'manual'); assert.equal(f.config.model, 'manual');
  assert.equal(loadConfig({workspace: f.root, home: f.config.home}, {}).model, 'manual');
});
test('无 API key 查询模型直接提示 /connect', async t => {
  const f = await fixture(t, {config: {provider: 'openai', api_key: '', model: ''}});
  await assert.rejects(chooseModel(f.engine), /\/connect/);
});
test('真实 CLI 无模型 ID 也能查询列表，管道命令按编号切换且保存', async t => {
  let requests = 0;
  const base = await serve(t, (req, res) => { requests++; json(res, {data: [{id: 'one'}, {id: 'two'}]}); });
  const f = await fixture(t);
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const child = spawn(process.execPath, [cli, '--no-banner'], {cwd: f.root, env: {...process.env,
    EDACODE_HOME: f.config.home, EDACODE_PROVIDER: 'openai', OPENAI_API_KEY: 'secret-only', OPENAI_BASE_URL: base,
    EDACODE_MODEL: '', MODEL_ID: '', NO_COLOR: '1'}});
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  child.stdin.end('/model\n/model 2\n/status\n/quit\n');
  const [code] = await once(child, 'close');
  assert.equal(code, 0, output); assert.match(output, /1\. one/); assert.match(output, /当前模型：two/);
  assert.equal(requests, 1); assert.equal(loadConfig({workspace: f.root, home: f.config.home}, {}).model, 'two');
  assert.ok(!output.includes('secret-only'));
});
test('取消模型选择时清空未提交输入，下一条斜杠命令不被污染', async t => {
  const source = new PassThrough(), target = new PassThrough(); source.isTTY = target.isTTY = true;
  source.setRawMode = () => {}; target.columns = 80; target.resume();
  const input = new Input(source, target), controller = new AbortController();
  t.after(async () => { input.close(); await new Promise(resolve => setImmediate(resolve)); source.destroy(); target.destroy(); });
  input.onInterrupt = () => controller.abort(new Error('cancelled'));
  const first = input.read('model: ', controller.signal); source.write('partial\x03'); await assert.rejects(first);
  const second = input.read('> '); source.write('/status\r'); assert.equal(await second, '/status');
});
