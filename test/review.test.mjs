import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewLines } from '../dist/review.js';

test('多段 diff 分别保留旧新行号和代码开头的加减号', () => {
  const rows = reviewLines('--- a.ts\n+++ a.ts\n@@ -3,2 +3,3 @@\n context\n---removed\n+++added\n+你好\n@@ -20 +21 @@\n-old\n+new\n\\ No newline at end of file\n');
  assert.deepEqual(rows.filter(row => row.kind === 'remove').map(row => [row.old, row.text]), [[4, '--removed'], [20, 'old']]);
  assert.deepEqual(rows.filter(row => row.kind === 'add').map(row => [row.next, row.text]), [[4, '++added'], [5, '你好'], [21, 'new']]);
  assert.equal(rows.at(-1).text, '\\ No newline at end of file');
});
test('创建与删除文件的行号从实际文件起点计算', () => {
  assert.equal(reviewLines('--- /dev/null\n+++ new\n@@ -0,0 +1 @@\n+new')[1].next, 1);
  assert.equal(reviewLines('--- old\n+++ /dev/null\n@@ -1 +0,0 @@\n-old')[1].old, 1);
});
