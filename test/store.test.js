// 存储层单元测试：纪元不变量、旧写拒绝、并发候选、复制中断/校验失败/发布崩溃恢复。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataStore, StoreError } from '../server/store.js';

let dir;
let store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'epochs-'));
  store = new DataStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function seeded(n = 3) {
  await store.createWorkspace('ws');
  await store.openPage('ws', 'p1');
  for (let i = 0; i < n; i++) {
    await store.putRecord('ws', 'p1', 'e1', { text: `观察 ${i + 1}`, author: '甲' });
  }
}

test('基本读写：记录只落在当前完整纪元', async () => {
  await seeded(2);
  const view = await store.read('ws');
  assert.equal(view.epoch, 'e1');
  assert.equal(view.complete, true);
  assert.equal(view.records.length, 2);
});

test('迁移：复制→校验→原子发布后，新纪元记录与旧纪元完全一致', async () => {
  await seeded(4);
  const before = (await store.read('ws')).records;
  const st = await store.migrate('ws');
  assert.equal(st.currentEpoch, 'e2');
  assert.equal(st.currentVersion, 2);
  assert.equal(st.migration, null);
  const after = (await store.read('ws')).records;
  assert.deepEqual(after, before);
});

test('旧页面发布后的迟到保存被拒绝并提示重新载入', async () => {
  await seeded(2);
  await store.openPage('ws', 'p2'); // p2 也持有 e1
  await store.migrate('ws');
  await assert.rejects(
    () => store.putRecord('ws', 'p2', 'e1', { text: '迟到记录' }),
    (e) => e instanceof StoreError && e.code === 'EPOCH_STALE' && e.reload === true,
  );
  // 重新打开后围栏刷新为 e2，可正常写
  await store.openPage('ws', 'p2');
  const freshView = await store.putRecord('ws', 'p2', 'e2', { text: '新纪元记录' });
  assert.equal(freshView.epoch, 'e2');
  assert.equal(freshView.records.length, 3);
});

test('复制进行中旧纪元封存，写入被拒绝（发布前后均拒绝）', async () => {
  await seeded(3);
  const migrateP = store.migrate('ws', undefined, { slowMs: 40 });
  // 迁移在途：并发写排队，最终因纪元已封存/过期被拒，绝不混入两套结构
  await assert.rejects(
    () => store.putRecord('ws', 'p1', 'e1', { text: '在途写入' }),
    (e) => e.code === 'EPOCH_SEALED' || e.code === 'EPOCH_STALE',
  );
  const st = await migrateP;
  assert.equal(st.currentEpoch, 'e2');
});

test('并发迁移不会创建第二个候选纪元', async () => {
  await seeded(3);
  const results = await Promise.allSettled([
    store.migrate('ws', 2, { slowMs: 60 }),
    store.migrate('ws', 2, { slowMs: 60 }),
    store.migrate('ws', 2, { slowMs: 60 }),
  ]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 2);
  assert.ok(rejected.every((r) => r.reason.code === 'MIGRATION_ACTIVE'));
  const st = await store.status('ws');
  assert.deepEqual(st.epochs, ['e1', 'e2']); // 没有 e3
  assert.equal(st.currentEpoch, 'e2');
});

test('复制中断：磁盘出现部分候选，但读取仍只暴露完整旧纪元', async () => {
  await seeded(3);
  await assert.rejects(() => store.migrate('ws', undefined, { failAfterCopy: 1 }), /中断/);
  // 重启进程视角：新实例
  const reopened = new DataStore(dir);
  const view = await reopened.read('ws');
  assert.equal(view.epoch, 'e1');
  assert.equal(view.records.length, 3, '绝不能读到部分复制数据');
  const st = await reopened.status('ws');
  assert.equal(st.migration.phase, 'copying');
  assert.equal(st.migration.candidateEpoch, 'e2');
  // 续用同一候选：恢复后发布
  const st2 = await reopened.recover('ws');
  assert.equal(st2.currentEpoch, 'e2');
  assert.equal((await reopened.read('ws')).records.length, 3);
});

test('校验失败：候选被安全回收，读取仍来自完整旧纪元', async () => {
  await seeded(3);
  await assert.rejects(() => store.migrate('ws', undefined, { failAfterCopy: 2 }));
  // 在 verifying 阶段制造候选与源不一致（模拟候选损坏）
  const file = join(dir, 'ws.json');
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  raw.epochs.e2.records = JSON.parse(JSON.stringify(raw.epochs.e1.records));
  raw.epochs.e2.complete = true;
  raw.epochs.e2.checksum = raw.epochs.e1.checksum;
  raw.migration.phase = 'verifying';
  const firstId = Object.keys(raw.epochs.e2.records)[0];
  raw.epochs.e2.records[firstId].text = '被污染';
  writeFileSync(file, JSON.stringify(raw));
  const reopened = new DataStore(dir);
  await assert.rejects(() => reopened.recover('ws'), (e) => e.code === 'VERIFY_FAILED');
  const st = await reopened.status('ws');
  assert.equal(st.currentEpoch, 'e1');
  assert.equal(st.migration, null);
  assert.ok(!st.epochs.includes('e2'), '不可信候选应被删除');
  assert.equal((await reopened.read('ws')).records.length, 3);
});

test('发布后崩溃：currentEpoch 已原子切换，重开只能读到完整新纪元', async () => {
  await seeded(3);
  await assert.rejects(
    () => store.migrate('ws', undefined, { crashAfterPublish: true }),
    (e) => e.code === 'PUBLISH_CRASH',
  );
  const reopened = new DataStore(dir);
  const view = await reopened.read('ws');
  assert.equal(view.epoch, 'e2');
  assert.equal(view.complete, true);
  assert.equal(view.records.length, 3);
  // committed 阶段恢复：仅清理标记，不会新建候选
  const st = await reopened.recover('ws');
  assert.equal(st.currentEpoch, 'e2');
  assert.equal(st.migration, null);
  assert.deepEqual(st.epochs, ['e1', 'e2']);
});

test('页面失效状态：发布后持有旧纪元的页面标记 invalid，重开恢复', async () => {
  await seeded(1);
  await store.openPage('ws', 'p2', { label: '旧标签页' });
  await store.migrate('ws');
  let st = await store.status('ws');
  const p2 = st.pages.find((p) => p.pageId === 'p2');
  assert.equal(p2.invalid, true);
  assert.equal(p2.heldEpoch, 'e1');
  await store.openPage('ws', 'p2');
  st = await store.status('ws');
  assert.equal(st.pages.find((p) => p.pageId === 'p2').invalid, false);
  assert.equal(st.pages.find((p) => p.pageId === 'p2').heldEpoch, 'e2');
});

test('发布后本地恢复一致：纪元、记录数、失效状态均可重复验证', async () => {
  await seeded(5);
  await store.openPage('ws', 'p2');
  await assert.rejects(() => store.migrate('ws', undefined, { failAfterCopy: 3 }));
  // “后来打开的页面”触发恢复
  const reopened = new DataStore(dir);
  await reopened.openPage('ws', 'p3'); // 新页面在恢复前拿到的是完整旧纪元
  assert.equal((await reopened.openPage('ws', 'p3')).epoch, 'e1');
  await reopened.recover('ws');
  const view = await reopened.read('ws');
  assert.equal(view.epoch, 'e2');
  assert.equal(view.records.length, 5);
  const st = await reopened.status('ws');
  assert.deepEqual(
    st.pages.map((p) => [p.pageId, p.heldEpoch, p.invalid]),
    [
      ['p1', 'e1', true],
      ['p2', 'e1', true],
      ['p3', 'e1', true], // 恢复前打开，仍持旧围栏 → 失效，提示重开
    ],
  );
  // 全部重开后失效清零
  for (const id of ['p1', 'p2', 'p3']) await reopened.openPage('ws', id);
  const st2 = await reopened.status('ws');
  assert.ok(st2.pages.every((p) => p.invalid === false));
});
