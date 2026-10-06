// HTTP/API 冒烟：真实启动服务，覆盖健康响应、页面加载、旧写拒绝、并发迁移、中断恢复。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const dataDir = mkdtempSync(join(tmpdir(), 'smoke-'));
const port = 8900 + Math.floor(Math.random() * 200);
// 编排模式：APP_BASE_URL 指向 compose 中的 app 服务，直接对其冒烟；否则本地自启服务。
const remoteBase = process.env.APP_BASE_URL || '';
const base = remoteBase || `http://127.0.0.1:${port}`;
const runId = Math.random().toString(36).slice(2, 8);

let failures = 0;
let restarted = false;
const check = (name, cond, extra = '') => {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name} ${extra}`);
  }
};

const srv = remoteBase
  ? null
  : spawn(process.execPath, ['server/main.js'], {
      cwd: root,
      env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ALLOW_FAULT_INJECTION: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
srv?.stdout.on('data', (d) => process.stdout.write(`[srv] ${d}`));
srv?.stderr.on('data', (d) => process.stderr.write(`[srv] ${d}`));

const api = async (path, opts = {}) => {
  const res = await fetch(base + path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
};

const waitReady = async () => {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(base + '/healthz');
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('服务未在 5s 内就绪');
};

async function seed(ws, n = 3) {
  const name = remoteBase ? `${ws}-${runId}` : ws;
  await api('/api/workspaces', { method: 'POST', body: { name } });
  await api(`/api/workspaces/${name}/pages/page-A/open`, { method: 'POST', body: { label: '甲页' } });
  for (let i = 1; i <= n; i++) {
    await api(`/api/workspaces/${name}/records`, {
      method: 'PUT',
      body: { pageId: 'page-A', epoch: 'e1', text: `${name}-记录${i}`, author: '甲' },
    });
  }
  return name;
}

try {
  await waitReady();
  console.log('— 健康与页面响应 —');
  const health = await fetch(base + '/healthz').then((r) => r.json());
  check('GET /healthz 返回 ok', health.ok === true);

  const home = await fetch(base + '/');
  const html = await home.text();
  check('GET / 200 且为页面', home.status === 200 && html.includes('野外实验站'));
  const appJs = await fetch(base + '/app.js');
  check('GET /app.js 200', appJs.status === 200);
  const css = await fetch(base + '/style.css');
  check('GET /style.css 200', css.status === 200);

  console.log('— 验收一：两个页面打开同一工作区，迁移后另一页旧编辑被拒绝 —');
  const s1 = await seed('station1');
  await api(`/api/workspaces/${s1}/pages/page-B/open`, { method: 'POST', body: { label: '乙页' } });
  const migrated = await api(`/api/workspaces/${s1}/migrate`, { method: 'POST', body: { targetVersion: 2 } });
  check('迁移发布到 e2 v2', migrated.status === 200 && migrated.body.currentEpoch === 'e2');
  const late = await api(`/api/workspaces/${s1}/records`, {
    method: 'PUT',
    body: { pageId: 'page-B', epoch: 'e1', text: '旧纪元迟到保存', author: '乙' },
  });
  check('发布后旧页迟到保存 409 拒绝', late.status === 409 && late.body.reload === true, JSON.stringify(late.body));
  check('拒绝原因 EPOCH_STALE 并提示重新载入', late.body.error === 'EPOCH_STALE');
  const reopened = await api(`/api/workspaces/${s1}/pages/page-B/open`, { method: 'POST' });
  check('重开后围栏指向新纪元', reopened.body.epoch === 'e2');
  const freshWrite = await api(`/api/workspaces/${s1}/records`, {
    method: 'PUT',
    body: { pageId: 'page-B', epoch: 'e2', text: '新纪元补录', author: '乙' },
  });
  check('重开后可在新纪元写入', freshWrite.status === 200 && freshWrite.body.records.length === 4);
  const st = await api(`/api/workspaces/${s1}/status`);
  check('状态展示各页面失效标记', st.body.pages.some((p) => p.pageId === 'page-A' && p.invalid === true));

  console.log('— 验收二：复制中断后重开，不展示部分复制数据，可续用同一候选 —');
  const s2 = await seed('station2');
  const interrupted = await api(`/api/workspaces/${s2}/migrate`, {
    method: 'POST',
    body: { fault: { failAfterCopy: 1 } },
  });
  check('复制中断返回 500', interrupted.status === 500 && interrupted.body.error === 'COPY_INTERRUPTED');
  const midRead = await api(`/api/workspaces/${s2}`);
  check('中断后读取仍是完整旧纪元 e1', midRead.body.epoch === 'e1' && midRead.body.records.length === 3, JSON.stringify(midRead.body));
  const midStatus = await api(`/api/workspaces/${s2}/status`);
  check('持久化阶段为 copying 且候选固定 e2',
    midStatus.body.migration?.phase === 'copying' && midStatus.body.migration.candidateEpoch === 'e2');
  const recover = await api(`/api/workspaces/${s2}/recover`, { method: 'POST' });
  check('续用同一候选恢复并发布 e2', recover.body.currentEpoch === 'e2' && recover.body.migration === null);
  const afterRead = await api(`/api/workspaces/${s2}`);
  check('恢复后记录完整（3 条，无重复/缺失）', afterRead.body.epoch === 'e2' && afterRead.body.records.length === 3);

  console.log('— 发布前在途旧写也被拒绝（封存）—');
  const s3 = await seed('station3');
  const migP = api(`/api/workspaces/${s3}/migrate`, { method: 'POST', body: { fault: { slowMs: 150 } } });
  await new Promise((r) => setTimeout(r, 80));
  const inFlight = await api(`/api/workspaces/${s3}/records`, {
    method: 'PUT',
    body: { pageId: 'page-A', epoch: 'e1', text: '迁移在途写入' },
  });
  await migP;
  check('迁移在途/发布前后的旧写被拒并提示 reload', inFlight.status === 409 && inFlight.body.reload === true, JSON.stringify(inFlight.body));

  console.log('— 并发迁移不得创建第二个候选 —');
  const s4 = await seed('station4');
  const results = await Promise.all([
    api(`/api/workspaces/${s4}/migrate`, { method: 'POST', body: { targetVersion: 3, fault: { slowMs: 120 } } }),
    api(`/api/workspaces/${s4}/migrate`, { method: 'POST', body: { targetVersion: 3, fault: { slowMs: 120 } } }),
  ]);
  const codes = results.map((r) => r.status);
  check('恰好一个成功一个 409', codes.includes(200) && codes.includes(409), JSON.stringify(codes));
  check('被拒原因 MIGRATION_ACTIVE', results.some((r) => r.body?.error === 'MIGRATION_ACTIVE'));
  const st4 = await api(`/api/workspaces/${s4}/status`);
  check('只有 e1/e2，未出现第二个候选 e3', JSON.stringify(st4.body.epochs) === JSON.stringify(['e1', 'e2']));
  check('目标版本为 v3', st4.body.currentVersion === 3);

  console.log('— 发布后崩溃：本地恢复的纪元、记录、失效状态一致 —');
  const s5 = await seed('station5');
  await api(`/api/workspaces/${s5}/pages/page-C/open`, { method: 'POST' });
  const crash = await api(`/api/workspaces/${s5}/migrate`, {
    method: 'POST',
    body: { fault: { crashAfterPublish: true } },
  });
  check('发布注入崩溃 500', crash.status === 500 && crash.body.error === 'PUBLISH_CRASH');
  const crashRead = await api(`/api/workspaces/${s5}`);
  check('崩溃后读取已是完整新纪元 e2', crashRead.body.epoch === 'e2' && crashRead.body.records.length === 3);
  const rec5 = await api(`/api/workspaces/${s5}/recover`, { method: 'POST' });
  check('committed 恢复仅清理标记，无新候选', rec5.body.currentEpoch === 'e2' && rec5.body.migration === null &&
    JSON.stringify(rec5.body.epochs) === JSON.stringify(['e1', 'e2']));
  const st5 = await api(`/api/workspaces/${s5}/status`);
  check('旧围栏页面失效，重开后恢复一致',
    st5.body.pages.find((p) => p.pageId === 'page-A').invalid === true &&
    st5.body.pages.find((p) => p.pageId === 'page-C').heldEpoch === 'e1');
  await api(`/api/workspaces/${s5}/pages/page-A/open`, { method: 'POST' });
  await api(`/api/workspaces/${s5}/pages/page-C/open`, { method: 'POST' });
  const st5b = await api(`/api/workspaces/${s5}/status`);
  check('全部重开后失效清零', st5b.body.pages.every((p) => p.invalid === false));

  if (!remoteBase) {
    console.log('— 真实进程重启：复制中断后杀死进程，新进程依据持久化阶段续用 —');
    const s6 = await seed('station6', 4);
    const cut = await api(`/api/workspaces/${s6}/migrate`, {
      method: 'POST',
      body: { fault: { failAfterCopy: 2 } },
    });
    check('复制在第 2 条后中断', cut.status === 500);
    srv.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    // 重启后使用新端口，避免与旧进程端口存活期混淆
    const port2 = port + 1;
    const base2 = `http://127.0.0.1:${port2}`;
    const srv2 = spawn(process.execPath, ['server/main.js'], {
      cwd: root,
      env: { ...process.env, PORT: String(port2), DATA_DIR: dataDir, ALLOW_FAULT_INJECTION: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let srv2Died = null;
    srv2.on('exit', (code) => { srv2Died = code; });
    srv2.stdout.on('data', (d) => process.stdout.write(`[srv2] ${d}`));
    srv2.stderr.on('data', (d) => process.stderr.write(`[srv2] ${d}`));
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(base2 + '/healthz')).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    check('重启后的新进程已就绪且未退出', srv2Died === null);
    const api2 = async (path, opts = {}) => {
      const res = await fetch(base2 + path, {
        headers: { 'content-type': 'application/json' },
        ...opts,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    // 后来打开的页面：读取只能来自完整旧纪元，绝不暴露部分候选
    const coldRead = await api2(`/api/workspaces/${s6}`);
    check('新进程冷启动读取仍是完整旧纪元（无部分复制数据）',
      coldRead.body?.epoch === 'e1' && coldRead.body.records.length === 4, JSON.stringify(coldRead.body));
    // 新页面在此刻打开：拿到完整旧纪元围栏
    const newPage = await api2(`/api/workspaces/${s6}/pages/page-NEW/open`, { method: 'POST' });
    check('新进程中新页面围栏为旧纪元', newPage.body.epoch === 'e1');
    // 依据持久化阶段续用同一候选（不是新建第二个候选）
    const cont = await api2(`/api/workspaces/${s6}/recover`, { method: 'POST' });
    check('续用同一候选发布 e2', cont.body.currentEpoch === 'e2' &&
      JSON.stringify(cont.body.epochs) === JSON.stringify(['e1', 'e2']), JSON.stringify(cont.body));
    const finalRead = await api2(`/api/workspaces/${s6}`);
    check('重开后读到新纪元完整 4 条记录',
      finalRead.body.epoch === 'e2' && finalRead.body.records.length === 4);
    // 新页面在恢复前持有 e1 → 失效；重新打开后一致
    const st6 = await api2(`/api/workspaces/${s6}/status`);
    check('恢复前打开的页面失效状态正确',
      st6.body.pages.find((p) => p.pageId === 'page-NEW')?.invalid === true);
    await api2(`/api/workspaces/${s6}/pages/page-NEW/open`, { method: 'POST' });
    const st6b = await api2(`/api/workspaces/${s6}/status`);
    check('重开后纪元与失效状态一致（NEW 刷新为 e2 有效；未重开的 A 保持失效）',
      st6b.body.pages.find((p) => p.pageId === 'page-NEW').heldEpoch === 'e2' &&
      st6b.body.pages.find((p) => p.pageId === 'page-NEW').invalid === false &&
      st6b.body.pages.find((p) => p.pageId === 'page-A').invalid === true,
      JSON.stringify(st6b.body));
    srv2.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
    restarted = true;
  }
} catch (e) {
  failures++;
  console.error('冒烟执行异常：', e);
} finally {
  if (!restarted) srv?.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 150));
  if (!remoteBase) rmSync(dataDir, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n冒烟结果：${failures} 项失败`);
  process.exit(1);
}
console.log('\n冒烟结果：全部通过');
process.exit(0);
