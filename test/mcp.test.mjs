import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture } from './helpers.mjs';
import { MCPServer, formatResult } from '../dist/mcp.js';
const serverFile = fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url));
const spec = {command: process.execPath, args: [serverFile]};
const setup = ({root}) => fs.writeFileSync(path.join(root, 'mcp.json'), JSON.stringify({mcpServers: {echo: spec}}));
test('MCP stdio 握手、发现、调用与失败标记', async t => {
  const f = await fixture(t, {setup}); assert.equal(f.tools.mcp.servers.size, 1); assert.equal(f.tools.definitions.has('mcp__echo__echo'), true);
  const [output, error] = await f.tools.call('mcp__echo__echo', {text: '你好'}); assert.equal(error, false); assert.equal(output, 'echo:你好');
  const [failure, failed] = await f.tools.call('mcp__echo__fail', {}); assert.equal(failed, true); assert.match(failure, /failed/);
});
test('MCP 启动失败不影响内置工具', async t => {
  const f = await fixture(t, {setup: ({root}) => fs.writeFileSync(path.join(root, 'mcp.json'), JSON.stringify({mcpServers: {broken: {command: 'definitely-not-real-edacode'}}}))});
  assert.equal(f.tools.mcp.servers.size, 0); assert.ok(f.tools.mcp.errors.length); assert.equal(f.tools.definitions.has('read_file'), true);
});
test('plan 模式不启动 MCP；ask 需要审批', async t => {
  const f = await fixture(t, {setup, config: {mode: 'plan'}}); assert.equal(f.tools.mcp.servers.size, 0); assert.match(f.tools.mcp.errors[0], /plan 模式禁止/);
  f.config.mode = 'ask'; const engine = await f.create({confirm: () => false}); assert.equal(engine.tools.mcp.servers.size, 0); assert.match(engine.tools.mcp.errors[0], /未批准/);
});
test('MCP 配置回退及调用中断', async t => {
  const f = await fixture(t); f.write('mcp.json', 'invalid'); f.write('.edacode/mcp.json', JSON.stringify({mcpServers: {echo: spec}}));
  const engine = await f.create(); assert.equal(engine.tools.mcp.servers.size, 1); assert.ok(engine.tools.mcp.errors.length);
  const server = engine.tools.mcp.servers.get('echo'), controller = new AbortController();
  const pending = server.call('wait', {}, controller.signal); setTimeout(() => controller.abort(new Error('cancelled')), 20); await assert.rejects(pending, /cancelled/);
});
test('MCP 请求超时和 server 提前退出不会永久等待', async t => {
  const f = await fixture(t); const server = new MCPServer('timeout', spec, f.root, 0.1); t.after(() => server.close()); await server.start();
  await assert.rejects(server.call('wait', {}), /超时/);
  const early = new MCPServer('early', {command: process.execPath, args: ['-e', 'process.exit(0)']}, f.root, 1); t.after(() => early.close()); await assert.rejects(early.start(), /退出/);
});
test('MCP 结果保留非文本块', () => { assert.match(formatResult({content: [{type: 'image', data: 'x'}]}), /image/); });
test('取消回合会结束 MCP 进程，继续时重新初始化', async t => {
  const f = await fixture(t, {setup});
  const oldServer = f.tools.mcp.servers.get('echo');
  f.engine.provider = {async complete() { return {text: '', calls: [{id: 'wait', name: 'mcp__echo__wait', arguments: {}}], input_tokens: 0, output_tokens: 0, stop: 'tool_use', message() { return {role: 'assistant', content: '', tool_calls: this.calls}; }}; }, close() {}};
  const run = f.engine.run('开始等待'); setTimeout(() => f.engine.cancel(), 50); assert.equal((await run).status, 'cancelled');
  assert.ok(oldServer.process.exitCode !== null || oldServer.process.signalCode !== null); assert.equal(f.tools.mcp.servers.size, 0);
  const {MockProvider} = await import('../dist/providers.js'); f.engine.provider = new MockProvider(); assert.equal((await f.engine.run('继续')).status, 'completed');
  assert.equal(f.tools.mcp.servers.size, 1); assert.notEqual(f.tools.mcp.servers.get('echo').process.pid, oldServer.process.pid);
});
