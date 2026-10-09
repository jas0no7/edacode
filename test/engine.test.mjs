import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, call, response, ScriptedProvider, nodeCommand } from './helpers.mjs';
import { Reply } from '../dist/types.js';
import { assertProtocol, compact } from '../dist/context.js';
import { Store, listSessions } from '../dist/storage.js';
import { anthropicMessages, openaiMessages } from '../dist/providers.js';

test('字符串工具参数、失败退出均返回模型', async t => {
  const f = await fixture(t, {}, [response(call('a', 'shell', '{"command":"exit 7"}')), new Reply('已发现失败')]);
  assert.equal((await f.engine.run('执行')).status, 'completed'); const result = f.engine.messages[2]; assert.equal(result.is_error, true); assert.equal(JSON.parse(result.content).exit_code, 7); assertProtocol(f.engine.messages);
});
test('工具参数 JSON 错误后循环仍能恢复', async t => {
  const f = await fixture(t, {}, [response(call('a', 'write_file', '{"path":')), new Reply('参数无效')]);
  assert.equal((await f.engine.run('错误参数')).status, 'completed'); assert.equal(f.engine.messages[2].is_error, true); assert.deepEqual(f.store.data.changes, []);
});
test('截断和重复工具 ID 均不执行', async t => {
  const action = call('a', 'write_file', {path: 'never', content: 'x'});
  const f = await fixture(t, {}, [new Reply('', [action], 0, 0, 'length'), response(action, action)]);
  assert.equal((await f.engine.run('截断')).status, 'limit'); assert.equal((await f.engine.run('重复')).status, 'error');
  assert.equal(fs.existsSync(path.join(f.root, 'never')), false); assertProtocol(f.engine.messages);
});
test('中断保留已完成结果，不重放尚未执行的工具', async t => {
  const f = await fixture(t, {}, [response(call('a', 'write_file', {path: 'once', content: 'once'}), call('b', 'write_file', {path: 'never', content: 'never'}))]);
  f.engine.hooks.add('after_tool', () => f.engine.cancel()); assert.equal((await f.engine.run('开始')).status, 'cancelled');
  assert.deepEqual(f.engine.messages.filter(m => m.role === 'tool').map(m => m.is_error), [false, true]); assert.equal(f.read('once'), 'once');
  assert.equal(fs.existsSync(path.join(f.root, 'never')), false); await f.store.close(); const store = await Store.open(f.config, f.store.id); f.stores.push(store);
  assert.deepEqual(store.data.messages, f.engine.messages); assertProtocol(store.data.messages);
});
test('进行中的模型请求可 Abort，取消后可继续下一回合', async t => {
  const f = await fixture(t, {}, [({signal}) => new Promise((_, reject) => { signal.addEventListener('abort', () => reject(signal.reason), {once: true}); }), new Reply('恢复成功')]);
  const run = f.engine.run('等待'); setTimeout(() => f.engine.cancel(), 50); assert.equal((await run).status, 'cancelled');
  assert.equal((await f.engine.run('继续')).status, 'completed');
});
test('进行中的 shell 可中断且不会等待原超时', async t => {
  const f = await fixture(t, {}, [response(call('a', 'shell', {command: nodeCommand('setTimeout(()=>{},30000)')}))]);
  f.engine.hooks.add('before_tool', () => { setTimeout(() => f.engine.cancel(), 50); });
  assert.equal((await f.engine.run('执行')).status, 'cancelled'); assert.equal([...f.tools.processes.jobs.values()][0].status, 'cancelled'); assertProtocol(f.engine.messages);
});
test('mock 无法判断 Goal 时保留失败状态', async t => {
  const f = await fixture(t); f.engine.setGoal('真实完成条件'); assert.equal((await f.engine.run('检查')).status, 'goal_failed'); assert.equal(f.engine.goal.status, 'failed');
});
test('无效 Goal 判断和网络失败保留活跃目标', async t => {
  const f = await fixture(t, {}, [new Reply('候选结果'), new Reply('{"ok":"true"}'), new Reply('重试结果'), new Error('temporary unavailable')]);
  f.engine.setGoal('有证据'); for (const task of ['开始', '继续']) { assert.equal((await f.engine.run(task)).status, 'error'); assert.equal(f.engine.goal.status, 'active'); }
  assert.equal(f.engine.goal.checks, 2);
});
test('Goal 未满足继续执行直到独立判断通过', async t => {
  const verdict = ok => new Reply(JSON.stringify({ok, reason: ok ? '已验证' : '补充验证', impossible: false}));
  const f = await fixture(t, {}, [new Reply('第一步'), verdict(false), new Reply('第二步'), verdict(true)]);
  f.engine.setGoal('完成两步'); assert.equal((await f.engine.run('开始')).status, 'completed'); assert.equal(f.engine.goal.checks, 2); assert.equal(f.engine.goal.status, 'completed');
});
test('max_turns、空回复和后台 pending 都不宣称完成', async t => {
  const f = await fixture(t, {config: {max_turns: 1}}, [response(call('a', 'list_files')), new Reply(''), new Reply('后台已启动')]);
  assert.equal((await f.engine.run('检查')).status, 'limit'); assert.equal((await f.engine.run('空回复')).status, 'error');
  const job = f.tools.processes.start(nodeCommand('setTimeout(()=>{},5000)')); assert.equal((await f.engine.run('后台')).status, 'pending'); await job.stop();
});
test('独立子 agent 上下文、会话和只读工具集合', async t => {
  const f = await fixture(t); f.engine.messages.push({role: 'user', content: '父任务'}); const original = structuredClone(f.engine.messages);
  const results = JSON.parse(await f.engine.delegate(['调查 A', '调查 B'])); assert.deepEqual(f.engine.messages, original); assert.equal(new Set(results.map(r => r.session)).size, 2);
  assert.deepEqual(listSessions(f.config).map(s => s.id), [f.store.id]);
  for (const r of results) { const store = await Store.open(f.config, r.session); f.stores.push(store); assert.equal(store.data.parent_session, f.store.id); assert.deepEqual(store.data.changes, []); }
  const child = await f.create({child: true}); assert.equal(child.tools.mcp, undefined); assert.equal(child.tools.definitions.has('shell'), false); assert.equal(child.tools.definitions.has('delegate'), false);
});
test('摘要失败时归档完整历史并保留成对工具结果', async t => {
  const f = await fixture(t, {}, [new Error('summary unavailable')]);
  for (let i = 0; i < 12; i++) f.engine.messages.push({role: 'user', content: `任务 ${i}`}, response(call(String(i), 'read_file', {path: 'a'})).message(), {role: 'tool', tool_call_id: String(i), content: 'x'.repeat(400)}, new Reply('done').message());
  f.engine.latestRequest = '真实用户目标'; const original = structuredClone(f.engine.messages); assert.equal(await compact(f.engine, true, 4000), true); assertProtocol(f.engine.messages);
  assert.match(f.engine.messages[0].content, /真实用户目标/); assert.ok(f.engine.messages.some(m => m.role === 'tool'));
  const file = fs.readdirSync(path.join(f.store.root, 'artifacts')).find(x => x.startsWith('history-')); assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.store.root, 'artifacts', file), 'utf8')), original);
});
test('上下文协议拒绝孤立、重复和缺少结果', () => {
  for (const messages of [[{role: 'tool', tool_call_id: 'a'}], [response(call('a', 'x')).message()], [response(call('a', 'x'), call('a', 'x')).message()]]) assert.throws(() => assertProtocol(messages));
});
test('Anthropic 合并相同角色、工具配对、空内容与无效参数包装', () => {
  const messages = [{role: 'user', content: 'a'}, {role: 'user', content: 'b'}, response(call('c', 'x', 'broken')).message(), {role: 'tool', tool_call_id: 'c', content: 'failure', is_error: true}];
  const wire = anthropicMessages(messages); assert.equal(wire.length, 3); assert.equal(wire[0].content.length, 2); assert.equal(wire[1].content[0].input._invalid_json, 'broken'); assert.equal(wire[2].content[0].is_error, true);
  assert.equal(anthropicMessages([new Reply().message()])[0].content[0].text, '(空响应)');
  assert.deepEqual(anthropicMessages([response(call('x', 'x', [])).message()])[0].content[0].input, {_invalid_input: []});
});
test('OpenAI wire format 与内部 Reply 保持可往返 JSON', () => {
  const reply = response(call('c', 'x', {path: 'a'})); const messages = [{role: 'user', content: 'a'}, reply.message(), {role: 'tool', tool_call_id: 'c', content: 'result'}];
  const wire = openaiMessages('system', messages); assert.equal(wire[0].role, 'system'); assert.equal(wire[2].tool_calls[0].function.arguments, '{"path":"a"}'); assert.equal(wire[3].tool_call_id, 'c');
  assert.deepEqual(JSON.parse(JSON.stringify(reply.message())), reply.message());
});
test('Hook 拒绝工具以及停止检查继续反馈', async t => {
  const f = await fixture(t, {}, [response(call('a', 'write_file', {path: 'never', content: 'x'})), new Reply('first'), new Reply('second')]);
  f.engine.hooks.add('before_tool', () => 'blocked'); let checks = 0; f.engine.hooks.add('stop', () => ++checks === 1 ? '继续检查' : undefined);
  assert.equal((await f.engine.run('执行')).status, 'completed'); assert.equal(fs.existsSync(path.join(f.root, 'never')), false); assert.match(f.engine.messages.find(m => m.role === 'tool').content, /Hook 拒绝/);
});
test('模型错误信息脱敏和长工具结果归档', async t => {
  const f = await fixture(t, {config: {api_key: 'secret-local-key'}}, [new Error('secret-local-key')]); assert.match((await f.engine.run('错误')).reason, /REDACTED/);
  f.write('many.txt', 'x'.repeat(50000)); const [out, error] = await f.tools.call('read_file', {path: 'many.txt'}); assert.equal(error, false); assert.match(out, /read_artifact/);
  const artifact = fs.readdirSync(path.join(f.store.root, 'artifacts')).find(x => x.startsWith('output-')); assert.match(f.store.readArtifact(artifact, 12000), /x{100}/);
});
