import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, response, call, nodeCommand } from './helpers.mjs';
import { Store, listSessions, digest, encode } from '../dist/storage.js';
import { Policy, checkCommand } from '../dist/permissions.js';
import { globMatch, validate } from '../dist/tools.js';
import { Reply } from '../dist/types.js';
import { assertProtocol, compact } from '../dist/context.js';
import { Processes, findShell } from '../dist/processes.js';
import { command } from '../dist/cli.js';

test('工作区路径、.git 和软链接边界', async t => {
  const f = await fixture(t);
  for (const value of ['../outside', '.git/config', f.config.home, '.state/secret']) assert.throws(() => f.tools.path(value));
  try { fs.symlinkSync(path.dirname(f.root), path.join(f.root, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (e) { if (e.code === 'EPERM') { t.diagnostic('平台不允许建立 symlink'); return; } throw e; }
  assert.throws(() => f.tools.path('outside-link/secret')); assert.throws(() => f.tools.path('outside-link/new/future.txt'));
});
test('状态目录在工作区内时仍被保护', async t => {
  const f = await fixture(t); f.write('.state/secret.txt', 'secret'); f.write('visible.txt', 'ok');
  assert.throws(() => f.tools.read_file({path: '.state/secret.txt'})); assert.equal(f.tools.list_files(), 'visible.txt');
});
test('读取前置、写入、精确编辑与撤销', async t => {
  const f = await fixture(t); await f.tools.write_file({path: 'a.txt', content: 'one\n'});
  await assert.rejects(f.tools.edit_file({path: 'a.txt', old_text: 'one', new_text: 'two'}), /未读取/);
  f.tools.read_file({path: 'a.txt'}); await f.tools.edit_file({path: 'a.txt', old_text: 'one', new_text: 'two'});
  assert.equal(f.read('a.txt'), 'two\n'); assert.match(f.tools.undo(), /已撤销/); assert.equal(f.read('a.txt'), 'one\n');
});
test('多个匹配要求 all，替换文本保持字面量', async t => {
  const f = await fixture(t); f.write('a.txt', 'x x'); f.tools.read_file({path: 'a.txt'});
  await assert.rejects(f.tools.edit_file({path: 'a.txt', old_text: 'x', new_text: 'y'}), /匹配 2/);
  await f.tools.edit_file({path: 'a.txt', old_text: 'x', new_text: '$&', all: true}); assert.equal(f.read('a.txt'), '$& $&');
});
test('读取后的外部修改和审批期间修改都拒绝覆盖', async t => {
  const f = await fixture(t); f.write('a.txt', 'old'); f.tools.read_file({path: 'a.txt'}); f.write('a.txt', 'external');
  await assert.rejects(f.tools.write_file({path: 'a.txt', content: 'next'}), /变化/);
  f.tools.read_file({path: 'a.txt'}); f.engine.policy.mode = 'ask';
  f.engine.policy.confirm = async () => { f.write('a.txt', 'during approval'); return true; };
  await assert.rejects(f.tools.write_file({path: 'a.txt', content: 'next'}), /审批期间/); assert.equal(f.read('a.txt'), 'during approval');
});
test('二进制、大文件、非 UTF-8 和未知参数拒绝', async t => {
  const f = await fixture(t); f.write('binary', Buffer.from([0])); f.write('invalid', Buffer.from([255])); f.write('large', 'x'.repeat(2_000_001));
  for (const file of ['binary', 'invalid', 'large']) assert.throws(() => f.tools.read_file({path: file}));
  const [out, error] = await f.tools.call('read_file', {path: 'large', extra: true}); assert.equal(error, true); assert.match(out, /未知参数/);
  for (const value of [true, 1.5, NaN, Infinity]) assert.throws(() => validate(value, {type: 'integer'}));
});
test('文件发现过滤、glob、搜索和目录规范', async t => {
  const f = await fixture(t); for (const name of ['src/a.ts', 'src/sub/b.ts', '.env', '.env.local', '.env.example', 'node_modules/no.ts', 'dist/no.ts', 'ignored/no.ts']) f.write(name, 'HELLO\n');
  f.write('.edacodeignore', 'ignored/\n'); f.write('src/AGENTS.md', '目录规范');
  assert.match(f.tools.list_files({pattern: 'src/**/*.ts'}), /src\/a.ts/); assert.match(f.tools.list_files({pattern: 'src/**/*.ts'}), /src\/sub\/b.ts/);
  assert.equal(globMatch('src/sub/a.ts', 'src/*.ts'), false); assert.equal(globMatch('src/a.ts', 'src/**/*.ts'), true);
  const files = f.tools.list_files(); assert.ok(!files.split('\n').includes('.env')); assert.ok(!files.includes('.env.local')); assert.ok(files.includes('.env.example'));
  assert.ok(!files.includes('node_modules')); assert.ok(!files.includes('ignored/no')); assert.match(f.tools.search({text: 'hello', case_sensitive: false}), /src\/a.ts:1/);
  assert.match(f.tools.read_file({path: 'src/sub/b.ts'}), /目录规范/);
});
test('mock tool loop 与 resume 不重放工具', async t => {
  const f = await fixture(t); f.write('project.txt', 'hello'); assert.equal((await f.engine.run('列出文件')).status, 'completed');
  assertProtocol(f.engine.messages); await f.engine.close(); await f.store.close();
  const resumed = await Store.open(f.config, f.store.id); f.stores.push(resumed); assert.equal(resumed.data.version, 2); assert.ok(resumed.data.messages.some(m => m.role === 'tool'));
});
test('会话锁排他且 release 后可重新获得', async t => {
  const f = await fixture(t); await assert.rejects(Store.open(f.config, f.store.id), /加锁|另一进程/);
  await f.store.close(); const resumed = await Store.open(f.config, f.store.id); f.stores.push(resumed);
});
test('恢复未完成的工具调用只记录状态未知', async t => {
  const f = await fixture(t); f.store.data.messages = [{role: 'user', content: 'x'}, response(call('a', 'write_file', {path: 'never', content: 'x'})).message()];
  f.store.save(); await f.store.close(); const store = await Store.open(f.config, f.store.id); f.stores.push(store);
  assertProtocol(store.data.messages); assert.equal(store.data.messages.at(-1).is_error, true); assert.equal(fs.existsSync(path.join(f.root, 'never')), false);
});
test('四种权限策略和无交互审批拒绝', async () => {
  for (const mode of ['plan', 'ask', 'edit', 'auto']) {
    const p = new Policy(mode); await p.authorize('read_file');
    if (['edit', 'auto'].includes(mode)) await p.authorize('write_file'); else await assert.rejects(p.authorize('write_file'));
    if (mode === 'auto') await p.authorize('shell'); else await assert.rejects(p.authorize('shell'));
  }
  const approved = new Policy('ask', () => true); await approved.authorize('shell');
});
test('危险命令在 auto 也不运行', async t => {
  const f = await fixture(t);
  for (const command of ['  sudo\tshutdown now', 'rm -rf /', 'mkfs x']) { const [out, error] = await f.tools.call('shell', {command}); assert.equal(error, true); assert.match(out, /硬拒绝/); }
  assert.equal(f.tools.processes.jobs.size, 0); assert.throws(() => checkCommand('dd if=/dev/zero'));
});
test('shell 工作目录、失败退出、超时和后台查询', async t => {
  const f = await fixture(t); const output = await f.tools.shell({command: nodeCommand('console.log(process.cwd())')});
  assert.equal(output.status, 'completed'); assert.match(output.output, new RegExp(f.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const [out, failed] = await f.tools.call('shell', {command: 'exit 7'}); assert.equal(failed, true); assert.equal(JSON.parse(out).exit_code, 7);
  const timeout = await f.tools.processes.run(nodeCommand('setTimeout(()=>{},5000)'), 0.1); assert.equal(timeout.status, 'timeout'); assert.notEqual(timeout.exit_code, null);
  const background = await f.tools.shell({command: 'echo background', background: true}); assert.equal(background.status, 'running');
  const result = await f.tools.job_status({job_id: background.job_id, wait: 2}); assert.equal(result.status, 'completed');
});
test('最多四个后台作业，取消与退出清理', async t => {
  const f = await fixture(t); const jobs = Array.from({length: 4}, () => f.tools.processes.start(nodeCommand('setTimeout(()=>{},5000)')));
  assert.throws(() => f.tools.processes.start('echo fifth'), /4/); assert.equal((await jobs[0].stop()).status, 'cancelled');
  await f.tools.processes.close(); assert.ok(jobs.every(j => j.status !== 'running'));
});
test('POSIX shell 完成后清理继承输出管道的后代', {skip: process.platform === 'win32'}, async t => {
  const f = await fixture(t); const result = await f.tools.shell({command: 'sleep 30 &'}); assert.equal(result.status, 'completed');
  assert.equal(f.tools.processes.get(result.job_id).process.stdout.destroyed, true);
});
test('计划限制一个进行中步骤，加载技能', async t => {
  const f = await fixture(t, {setup: ({root}) => { fs.mkdirSync(path.join(root, 'skills/review'), {recursive: true}); fs.writeFileSync(path.join(root, 'skills/review/SKILL.md'), '---\ndescription: 审查代码\n---\n审查规则'); }});
  assert.throws(() => f.tools.update_plan({items: [{status: 'in_progress'}, {status: 'in_progress'}]}));
  assert.match(f.tools.load_skill({name: 'review'}), /审查规则/); assert.match(f.engine.system(), /审查代码/);
});
test('自动检查点回滚文件、对话、计划和 Goal', async t => {
  const f = await fixture(t); f.write('old.txt', 'before'); f.tools.read_file({path: 'old.txt'});
  f.engine.messages.push({role: 'user', content: 'start'}); f.store.data.todos = [{step: 'before', status: 'pending'}]; f.engine.setGoal('before');
  f.store.beginCheckpoint(); await f.tools.edit_file({path: 'old.txt', old_text: 'before', new_text: 'after'}); await f.tools.write_file({path: 'new.txt', content: 'new'});
  assert.equal(f.store.data.checkpoints.length, 1); f.engine.messages.push(new Reply('after').message()); f.store.data.todos = []; f.engine.setGoal('after');
  const result = f.engine.restore(); assert.equal(f.read('old.txt'), 'before'); assert.equal(fs.existsSync(path.join(f.root, 'new.txt')), false);
  assert.equal(f.engine.messages.length, 1); assert.equal(f.engine.goal.condition, 'before'); assert.equal(f.store.data.todos[0].step, 'before'); assert.equal(result.reverted.length, 2);
});
test('检查点跳过外部修改的文件', async t => {
  const f = await fixture(t); f.store.beginCheckpoint(); await f.tools.write_file({path: 'x', content: 'agent'}); f.write('x', 'human');
  const result = f.engine.restore(); assert.equal(result.skipped.length, 1); assert.equal(f.read('x'), 'human');
});
test('压缩后拒绝截断对话但仍回滚文件', async t => {
  const f = await fixture(t); f.engine.messages.push({role: 'user', content: 'original'}); f.store.beginCheckpoint(); await f.tools.write_file({path: 'x', content: 'x'});
  f.store.data.generation++; f.engine.messages.splice(0, 1, {role: 'user', content: 'compressed'}); const result = f.engine.restore();
  assert.match(result.conversation, /历史已被重写/); assert.equal(f.engine.messages[0].content, 'compressed'); assert.equal(fs.existsSync(path.join(f.root, 'x')), false);
});
test('手动检查点无需修改文件；丢弃分支不能截断新工作', async t => {
  const f = await fixture(t); f.engine.messages.push({role: 'user', content: 'first'}); const first = f.store.makeCheckpoint('first');
  f.engine.messages.push(new Reply('old answer').message()); const old = f.store.makeCheckpoint('old'); f.engine.restore(first);
  f.engine.messages.push(new Reply('new answer').message(), {role: 'user', content: 'keep'}); assert.throws(() => f.engine.restore(old), /分支已变化/); assert.equal(f.engine.messages.length, 3);
});
test('检查点优先淘汰自动项并保留手动项', async t => {
  const f = await fixture(t); const manual = f.store.makeCheckpoint('manual');
  for (let i = 0; i < 35; i++) { f.store.beginCheckpoint(); f.store.commitCheckpoint('auto'); }
  assert.equal(f.store.data.checkpoints.length, 30); assert.ok(f.store.data.checkpoints.some(c => c.id === manual));
});
test('用户记忆持久化、去重及 clear', async t => {
  const f = await fixture(t); await Promise.all([f.engine.memory.update('项目用 TypeScript'), f.engine.memory.update('测试用 node:test')]);
  await f.engine.memory.update('项目用 TypeScript'); assert.equal(f.engine.memory.items.length, 2); assert.match(f.engine.memory.prompt('TypeScript'), /TypeScript/);
  await f.engine.memory.update(undefined, true); assert.deepEqual(f.engine.memory.items, []);
});
test('斜杠命令状态、切换、列举、检查点及清空', async t => {
  const f = await fixture(t); const invoke = text => command(text, f.config, f.store, f.engine);
  assert.equal(JSON.parse(await invoke('/status')).workspace, f.root); assert.match(await invoke('/mode plan'), /plan/); assert.equal(f.engine.policy.mode, 'plan');
  assert.match(await invoke('/model local'), /local/); assert.match(await invoke('/model'), /当前模型：local/); assert.match(await invoke('/tools'), /read_file/);
  assert.match(await invoke('/checkpoint tag'), /已创建/); assert.match(await invoke('/restore'), /tag/); assert.match(await invoke('/sessions'), new RegExp(f.store.id));
  f.engine.messages.push({role: 'user', content: 'history'}); await invoke('/clear'); assert.deepEqual(f.engine.messages, []); assert.deepEqual(f.store.data.checkpoints, []);
});
