import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers.mjs';
import { Store, projectRoot, digest, encode } from '../dist/storage.js';
import { Engine } from '../dist/engine.js';
const sessionFixture = fs.readFileSync(new URL('./fixtures/session-v1.json', import.meta.url), 'utf8');
const checkpointFixture = fs.readFileSync(new URL('./fixtures/checkpoint-v1.json', import.meta.url), 'utf8');
function legacy(f, mutate) {
  const source = sessionFixture.replace('__WORKSPACE__', JSON.stringify(f.config.workspace).slice(1, -1));
  const data = JSON.parse(source); const root = path.join(projectRoot(f.config), 'sessions', data.id); fs.mkdirSync(path.join(root, 'checkpoints'), {recursive: true});
  fs.writeFileSync(path.join(root, 'session.json'), mutate ? mutate(source) : source);
  fs.writeFileSync(path.join(root, 'checkpoints', data.checkpoints[0].id + '.json'), checkpointFixture);
  fs.writeFileSync(path.join(root, 'events.jsonl'), '{"type":"legacy"}\n');
  fs.mkdirSync(path.join(root, 'artifacts')); fs.writeFileSync(path.join(root, 'artifacts', 'original.txt'), 'original artifact');
  return {data, root, source};
}
test('Python v1 中文、浮点及数字键检查点验证后单向迁移', async t => {
  const f = await fixture(t); const old = legacy(f); f.write('legacy.txt', 'after');
  const store = await Store.open(f.config, old.data.id); f.stores.push(store); const engine = await f.create({}, store);
  assert.equal(store.data.version, 2); assert.equal(store.data.migrated_from, 1); assert.deepEqual(store.data.messages, old.data.messages);
  assert.equal(fs.readFileSync(path.join(old.root, 'legacy-v1-backup/session.json'), 'utf8'), old.source);
  assert.equal(fs.readFileSync(path.join(old.root, 'legacy-v1-backup/artifacts/original.txt'), 'utf8'), 'original artifact');
  const cp = store.checkpoint(old.data.checkpoints[0].id); assert.equal(cp.messages_digest, digest(encode(store.data.messages)));
  engine.restore(cp.id); assert.equal(f.read('legacy.txt'), 'before'); assert.equal(store.data.todos[0].step, '检查');
  await store.close(); const again = await Store.open(f.config, old.data.id); f.stores.push(again); assert.equal(again.data.version, 2);
});
test('旧检查点哈希损坏拒绝回滚且保留备份', async t => {
  const f = await fixture(t); const old = legacy(f); const file = path.join(old.root, 'checkpoints', old.data.checkpoints[0].id + '.json');
  const checkpoint = JSON.parse(fs.readFileSync(file, 'utf8')); checkpoint.messages_digest = 'invalid'; fs.writeFileSync(file, JSON.stringify(checkpoint));
  const store = await Store.open(f.config, old.data.id); f.stores.push(store); const engine = await f.create({}, store); f.write('legacy.txt', 'after');
  assert.throws(() => engine.restore(checkpoint.id), /无法验证/); assert.equal(f.read('legacy.txt'), 'after');
});
test('旧分支或压缩前检查点无法验证时拒绝恢复', async t => {
  const f = await fixture(t); const old = legacy(f, source => source.replace('"generation": 0', '"generation": 1'));
  const store = await Store.open(f.config, old.data.id); f.stores.push(store); assert.throws(() => store.checkpoint(old.data.checkpoints[0].id), /无法验证/);
});
test('迁移中断后从原始备份重试，不重复覆盖备份', async t => {
  const f = await fixture(t); const old = legacy(f); let store = await Store.open(f.config, old.data.id); await store.close();
  const migratedCheckpoint = fs.readFileSync(path.join(old.root, 'checkpoints', old.data.checkpoints[0].id + '.json'), 'utf8');
  fs.writeFileSync(path.join(old.root, 'session.json'), old.source); store = await Store.open(f.config, old.data.id); f.stores.push(store);
  assert.equal(fs.readFileSync(path.join(old.root, 'checkpoints', old.data.checkpoints[0].id + '.json'), 'utf8'), migratedCheckpoint);
  assert.equal(fs.readFileSync(path.join(old.root, 'legacy-v1-backup/session.json'), 'utf8'), old.source);
});
test('超出安全整数范围时拒绝迁移并保留原数据', async t => {
  const f = await fixture(t); const old = legacy(f, source => source.replace('"ratio": 1.0', '"ratio": 9007199254740993'));
  const before = fs.readFileSync(path.join(old.root, 'session.json'), 'utf8'); await assert.rejects(Store.open(f.config, old.data.id), /安全整数/);
  assert.equal(fs.readFileSync(path.join(old.root, 'session.json'), 'utf8'), before);
});
test('项目记忆保持路径和内容，legacy 工具未完成不重放', async t => {
  const f = await fixture(t); const old = legacy(f, source => { const data = JSON.parse(source); data.messages = data.messages.slice(0, 2); delete data.messages[1].tool_calls[0].arguments.huge; data.checkpoints = []; return JSON.stringify(data); });
  fs.writeFileSync(path.join(projectRoot(f.config), 'memory.json'), '[{"text":"旧记忆","saved":1}]');
  const store = await Store.open(f.config, old.data.id); f.stores.push(store); const engine = await f.create({}, store);
  assert.equal(engine.memory.items[0].text, '旧记忆'); assert.equal(engine.messages.at(-1).is_error, true); assert.match(engine.messages.at(-1).content, /状态未知/);
});
