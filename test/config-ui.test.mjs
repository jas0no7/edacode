import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixture } from './helpers.mjs';
import { loadConfig, validateConfig, modelReady, requireModelConfig } from '../dist/config.js';
import { Palette, PLAIN, logo, visibleWidth, statusBar, welcome, shortenHome, strip, safeTerminal } from '../dist/ui.js';
import { parseArgs } from '../dist/cli.js';

test('用户级配置兜底且环境变量不被修改', async t => {
  const f = await fixture(t); f.write('.state/.env', 'EDACODE_PROVIDER=openai\nEDACODE_MODEL=home-model\nOPENAI_API_KEY=home-key');
  const env = {}; const config = loadConfig({workspace: f.root, home: f.config.home}, env); assert.equal(config.model, 'home-model'); assert.equal(config.api_key, 'home-key'); assert.deepEqual(env, {});
});
test('工作区覆盖用户配置，导出变量优先', async t => {
  const f = await fixture(t); f.write('.state/.env', 'EDACODE_MODEL=home\nOPENAI_API_KEY=home-key'); f.write('.env', 'EDACODE_PROVIDER=openai\nEDACODE_MODEL=project\nOPENAI_API_KEY=project-key');
  const config = loadConfig({workspace: f.root, home: f.config.home}, {OPENAI_API_KEY: 'exported'}); assert.equal(config.model, 'project'); assert.equal(config.api_key, 'exported');
});
test('显式 env-file 独占加载且缺少文件报错', async t => {
  const f = await fixture(t); f.write('.env', 'EDACODE_MODEL=wrong'); f.write('.state/.env', 'EDACODE_MODEL=wrong'); f.write('explicit.env', 'EDACODE_PROVIDER=openai\nEDACODE_MODEL=explicit\nOPENAI_API_KEY=test');
  const args = {workspace: f.root, home: f.config.home, env_file: path.join(f.root, 'explicit.env')}; assert.equal(loadConfig(args, {}).model, 'explicit');
  assert.throws(() => loadConfig({...args, env_file: path.join(f.root, 'missing')}, {}), /不存在/);
});
test('无密钥允许启动，模型请求才检查配置并提示连接命令和位置', async t => {
  const f = await fixture(t); const config = loadConfig({workspace: f.root, home: f.config.home}, {});
  assert.equal(modelReady(config), false);
  assert.throws(() => requireModelConfig(config), error => error.message.includes('/connect') && error.message.includes(f.root) && error.message.includes(f.config.home));
  for (const value of [0, -1, 1.5, NaN]) assert.throws(() => validateConfig({...f.config, max_turns: value}));
});
test('logo 五行等宽和 CJK 宽度', () => { const rows = logo(); assert.equal(rows.length, 5); assert.equal(new Set(rows.map(visibleWidth)).size, 1); assert.equal(visibleWidth('\x1b[31m你好\x1b[0m'), 4); });
test('纯文本调色板、欢迎屏及状态栏', async t => {
  const f = await fixture(t); const text = welcome(f.config, f.tools, PLAIN, 120);
  assert.ok(!text.includes('\x1b')); assert.match(text, /mock/); assert.match(text, /Auto/); assert.match(text, /0\.2\.0/); assert.ok(text.includes(f.root));
  assert.equal(visibleWidth(statusBar(f.config, f.tools, PLAIN, 150)), 150);
});
test('带色和纯文本欢迎屏对齐一致', async t => {
  const f = await fixture(t); const plain = welcome(f.config, f.tools, PLAIN, 100), colored = welcome(f.config, f.tools, new Palette(true), 100);
  assert.equal(strip(colored), plain); assert.deepEqual(colored.split('\n').map(visibleWidth), plain.split('\n').map(visibleWidth));
});
test('home 缩写仅替换完整路径前缀，终端控制码清理', () => {
  assert.equal(shortenHome(path.join(os.homedir(), 'project')), '~' + path.sep + 'project'); assert.equal(shortenHome(os.homedir() + '-other/project'), os.homedir() + '-other/project');
  assert.equal(safeTerminal('\x1b]0;bad\x07hello\x1b[31m!\x00'), 'hello!');
});
test('CLI 参数保持兼容并验证冲突', () => {
  assert.deepEqual(parseArgs(['--resume']).resume, 'latest'); assert.equal(parseArgs(['--resume=id']).resume, 'id'); assert.equal(parseArgs(['-p', 'task', '--json']).no_stream, true);
  assert.equal(parseArgs(['--workspace=/tmp', 'hello', 'world']).query.join(' '), 'hello world');
  for (const args of [['--json'], ['-p', 'task', 'other'], ['--workspace'], ['--unknown'], ['--json=true']]) assert.throws(() => parseArgs(args));
});
