import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectWorkspace } from '../dist/workspace-status.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'edacode-status-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  return root;
}
test('工作区卡片读取实际 Git 分支、干净状态及变更，文件计数排除依赖和状态目录', async t => {
  const root = await fixture(t);
  const git = (...args) => execFileSync('git', ['-C', root, ...args], {stdio: 'pipe'});
  git('init', '-b', 'dashboard-test'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  await fs.writeFile(path.join(root, '中文.txt'), 'first');
  git('add', '中文.txt'); git('commit', '-m', 'fixture');
  for (const name of ['node_modules', '.edacode', 'custom-state']) {
    await fs.mkdir(path.join(root, name)); await fs.writeFile(path.join(root, name, 'excluded'), 'hidden');
  }
  await fs.writeFile(path.join(root, '.gitignore'), 'node_modules/\n.edacode/\ncustom-state/\n');
  git('add', '.gitignore'); git('commit', '-m', 'ignore');
  const signal = new AbortController().signal;
  const clean = await inspectWorkspace(root, signal, path.join(root, 'custom-state'));
  assert.equal(clean.branch, 'dashboard-test'); assert.equal(clean.git, 'clean'); assert.equal(clean.files, 2);
  await fs.writeFile(path.join(root, '中文.txt'), 'changed');
  const changed = await inspectWorkspace(root, signal, path.join(root, 'custom-state'));
  assert.equal(changed.git, 'modified'); assert.equal(changed.changes, 1); assert.equal(changed.files, 2);
});
test('非 Git 目录和不存在的目录不会显示虚假的 Clean 或文件数量', async t => {
  const root = await fixture(t), signal = new AbortController().signal;
  await fs.writeFile(path.join(root, 'file'), 'text');
  const plain = await inspectWorkspace(root, signal);
  assert.equal(plain.git, 'unavailable'); assert.equal(plain.files, 1);
  const missing = await inspectWorkspace(path.join(root, 'missing'), signal);
  assert.equal(missing.git, 'unavailable'); assert.equal(missing.files, undefined);
});
test('退出时可中断工作区检查', async t => {
  const root = await fixture(t), controller = new AbortController();
  controller.abort(); await assert.rejects(inspectWorkspace(root, controller.signal), {name: 'AbortError'});
});
