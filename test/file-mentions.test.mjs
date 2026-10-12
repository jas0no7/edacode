import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers.mjs';
import { discoverMentionFiles, fuzzyFiles, fileReference } from '../dist/file-mentions.js';
import { injectReferences } from '../dist/commands.js';

test('文件索引递归发现中文路径，过滤依赖、配置秘密、状态与忽略项', async t => {
  const f = await fixture(t);
  for (const file of ['src/UserService.ts', '文档/使用 说明.md', '.env', '.env.local', '.env.example', 'node_modules/pkg/index.js', 'dist/app.js', 'build/app.js', '.git/config', 'private/hidden.txt', 'logs/debug.log']) f.write(file, 'content');
  f.write('.edacodeignore', 'private/\n*.log');
  const index = await discoverMentionFiles(f.root, f.config.home, new AbortController().signal);
  assert.deepEqual(index.files, ['.edacodeignore', '.env.example', 'src/UserService.ts', '文档/使用 说明.md']);
  assert.equal(index.limited, false);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(discoverMentionFiles(f.root, f.config.home, controller.signal), {name: 'AbortError'});
});
test('文件索引拒绝越界、状态目录和目录软链接，允许工作区内文件链接', {skip: process.platform === 'win32'}, async t => {
  const f = await fixture(t), outside = await fixture(t);
  outside.write('secret', 'outside'); f.write('src/a.ts', 'inside'); f.write('.state/secret', 'private');
  fs.symlinkSync(path.join(outside.root, 'secret'), path.join(f.root, 'outside'));
  fs.symlinkSync(path.join(f.root, '.state/secret'), path.join(f.root, 'state-link'));
  fs.symlinkSync(path.join(f.root, 'src'), path.join(f.root, 'loop-dir'));
  fs.symlinkSync(path.join(f.root, 'src/a.ts'), path.join(f.root, 'linked.ts'));
  const result = await discoverMentionFiles(f.root, f.config.home, new AbortController().signal);
  assert.deepEqual(result.files, ['linked.ts', 'src/a.ts']);
});
test('模糊搜索支持大小写、非连续路径、中文及文件名优先排序', () => {
  const files = ['src/UserService.ts', 'src/utils/serialize.ts', 'docs/userservice.ts', '文档/使用 说明.md'];
  assert.deepEqual(fuzzyFiles(files, ''), files);
  assert.equal(fuzzyFiles(files, 'USRsvc')[0], 'src/UserService.ts');
  assert.equal(fuzzyFiles(files, 'src\\usrsvc')[0], 'src/UserService.ts');
  assert.deepEqual(fuzzyFiles(files, '用说'), ['文档/使用 说明.md']);
  assert.deepEqual(fuzzyFiles(files, 'notfound'), []);
  assert.deepEqual(fuzzyFiles(['main/index.ts', 'index.ts', 'src/index.ts'], 'index.ts'), ['index.ts', 'main/index.ts', 'src/index.ts']);
});
test('选择结果引用支持空格、中文及特殊字符，正文只注入一次且不授予读取状态', async t => {
  const f = await fixture(t); f.write('nested.txt', 'NEVER_EXPAND');
  const files = ['a.ts', '文档/使用 说明.md', 'name@value.txt', 'braces{test}.txt', 'punct!.txt'];
  if (process.platform !== 'win32') files.push('quote"test.txt', 'back\\slash.txt', 'trailing ');
  for (const [i, file] of files.entries()) {
    f.write(file, `unique-content-${i} @nested.txt !{touch never}`);
    const expanded = injectReferences('请读 ' + fileReference(file), f.tools);
    assert.match(expanded, new RegExp(`unique-content-${i}`));
    assert.ok(!expanded.includes('NEVER_EXPAND'));
    assert.match(expanded, /!\{touch never\}/);
  }
  assert.equal(f.tools.readSeen.size, 0);
  assert.equal(injectReferences('mail me@example.com', f.tools), 'mail me@example.com');
});
