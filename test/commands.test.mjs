import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
import { discoverCommands, expand, injectReferences, substitute, injectFiles } from '../dist/commands.js';

test('项目自定义命令覆盖用户命令并保留命名空间', async t => {
  const f = await fixture(t); f.write('.state/commands/git/commit.md', '用户版'); f.write('.edacode/commands/git/commit.md', '---\ndescription: 生成提交信息\nargument-hint: <path>\n---\n项目版');
  const commands = discoverCommands(f.root, f.config.home); assert.equal(commands.get('git:commit').body, '项目版'); assert.equal(commands.get('git:commit').source, 'project'); assert.equal(commands.get('git:commit').description, '生成提交信息');
});
test('全部占位符和引用文件展开', async t => {
  const f = await fixture(t); f.write('a.txt', 'content'); assert.equal(substitute('{{args}} $ARGUMENTS $1 ${2}', 'one two'), 'one two one two one two');
  const result = await expand({body: 'Review $1\n@{$1}'}, 'a.txt', f.tools); assert.match(result, /content/); assert.match(result, /Review a.txt/);
});
test('没有占位符的模板追加参数', async t => { const f = await fixture(t); assert.equal(await expand({body: 'Review'}, 'a b', f.tools), 'Review\n\na b'); });
test('普通文件和目录引用支持路径并避免误替换 email', async t => {
  const f = await fixture(t); f.write('src/a.ts', 'source'); f.write('example.com', 'not email');
  assert.match(injectReferences('读 @src/a.ts', f.tools), /source/); assert.match(injectReferences('目录 @src', f.tools), /src\/a.ts/);
  assert.equal(injectReferences('me@example.com @missing', f.tools), 'me@example.com @missing');
});
test('注入上下文不授予文件读取前置状态', async t => {
  const f = await fixture(t); f.write('a', 'x'); injectFiles('@{a}', f.tools); await assert.rejects(f.tools.edit_file({path: 'a', old_text: 'x', new_text: 'y'}), /未读取/);
});
test('shell 注入走权限，auto 执行而 plan 拒绝', async t => {
  const f = await fixture(t); assert.match(await expand({body: '!{echo injected}'}, '', f.tools), /injected/);
  f.engine.policy.mode = 'plan'; const result = await expand({body: '!{echo forbidden}'}, '', f.tools); assert.match(result, /plan 模式禁止/);
});
test('文件内容和参数不能创建新的注入操作', async t => {
  const f = await fixture(t); f.write('payload', '!{touch never}'); let calls = 0; f.tools.call = async () => { calls++; throw new Error('unexpected shell'); };
  assert.match(await expand({body: '@{payload}'}, '', f.tools), /!\{touch never\}/); assert.equal(await expand({body: 'Review {{args}}'}, '!{touch never}', f.tools), 'Review !{touch never}'); assert.equal(calls, 0);
});
test('shell 块按模板顺序执行且输出保持数据', async t => {
  const f = await fixture(t); const seen = []; f.tools.call = async (_, args) => { seen.push(args.command); return ['@{secret} !{third}', false]; };
  const prompt = await expand({body: '!{first} then !{second}'}, '', f.tools); assert.deepEqual(seen, ['first', 'second']); assert.equal(prompt.match(/!\{third\}/g).length, 2);
});
test('shell 参数转义为一个字面量', async t => {
  const f = await fixture(t); const seen = []; f.tools.call = async (_, args) => { seen.push(args.command); return ['ok', false]; };
  await expand({body: '!{printf %s {{args}}}'}, 'a; touch never', f.tools); assert.deepEqual(seen, ["printf %s 'a; touch never'"]);
  assert.equal(substitute('echo $1', '"a b"', true), "echo 'a b'");
});
test('拒绝引号内占位符、heredoc 和嵌套注入', async t => {
  const f = await fixture(t);
  for (const template of ['echo "{{args}}"', "echo '$1'", 'cat <<EOF\n$ARGUMENTS\nEOF']) assert.throws(() => substitute(template, '$(touch never)', true));
  await assert.rejects(expand({body: '@{!{nested}}'}, '', f.tools), /嵌套/);
});
