// 前端：每个标签页一个 pageId（围栏），保存时携带当前持有的纪元；
// 轮询状态展示当前纪元、阶段、持有围栏的页面与失效状态；收到 reload 信号即提示重新载入。
const $ = (id) => document.getElementById(id);

const pageId =
  sessionStorage.getItem('pageId') ||
  ((p) => (sessionStorage.setItem('pageId', p), p))(`page-${Math.random().toString(36).slice(2, 10)}`);

let ws = null;
let heldEpoch = null; // 本页围栏：只有保存时的纪元与服务端当前纪元一致才允许写
let pollTimer = null;

const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : {},
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.message || res.statusText);
    e.code = data.error;
    e.reload = data.reload;
    e.detail = data;
    throw e;
  }
  return data;
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const msg = (el, text, kind = '') => {
  el.textContent = text;
  el.className = `msg ${kind}`;
};

async function openWorkspace(create) {
  const name = $('wsName').value.trim();
  if (!name) return msg($('gateMsg'), '请输入工作区名称', 'err');
  try {
    if (create) await api('/api/workspaces', { method: 'POST', body: { name } });
    const view = await api(`/api/workspaces/${encodeURIComponent(name)}/pages/${pageId}/open`, { method: 'POST', body: {} });
    ws = name;
    heldEpoch = view.epoch;
    sessionStorage.setItem('ws', name);
    $('workspace').hidden = false;
    $('gate').hidden = true;
    const label = `标签页 ${pageId.slice(-4)}`;
    $('fenceBadge').textContent = `${label} · 持有 ${heldEpoch}`;
    await refresh();
    startPolling();
    msg($('gateMsg'), '', '');
  } catch (e) {
    msg($('gateMsg'), `打开失败：${e.message}`, 'err');
  }
}

function showStaleBanner(text) {
  $('staleBanner').hidden = false;
  $('staleText').textContent = text;
  // 旧页面：停用编辑，等待用户重新载入
  $('btnSave').disabled = true;
  $('recText').disabled = true;
}

async function refresh() {
  if (!ws) return;
  try {
    const [view, st] = await Promise.all([
      api(`/api/workspaces/${ws}`),
      api(`/api/workspaces/${ws}/status`),
    ]);
    render(view, st);
  } catch (e) {
    // 网络/进程重启后仍可续用：下一轮继续
  }
}

function render(view, st) {
  // 当前纪元变了（发布完成）或写入被拒提示 reload：本页围栏失效
  if (heldEpoch && heldEpoch !== view.epoch) {
    showStaleBanner(`本页仍停留在 ${heldEpoch}，当前已是 ${view.epoch}。旧纪元的迟到保存已被拒绝，请重新载入读取完整新纪元。`);
  }

  $('curEpoch').textContent = view.epoch;
  $('curVersion').textContent = `目标版本 v${view.version}`;
  $('phase').textContent = st.migration ? st.migration.phase : '空闲（无候选）';
  $('candidate').textContent = st.migration ? st.migration.candidateEpoch : '–';
  $('sealed').textContent = st.sealed ? '是（旧纪元封存，拒绝旧写）' : '否';

  $('pagesBody').innerHTML = st.pages
    .map(
      (p) => `<tr>
        <td>${esc(p.label)}<br><span class="meta">${esc(p.pageId)}</span></td>
        <td><span class="tag">${esc(p.heldEpoch)} (v${p.heldVersion ?? '?'})</span></td>
        <td><span class="meta">${esc(p.lastSeen)}</td>
        <td><span class="tag ${p.invalid ? 'invalid' : ''}">${p.invalid ? '已失效' : '有效'}</span></td>
    </tr>`,
    )
    .join('');

  const records = view.records || [];
  $('records').innerHTML = records
    .map((r) => `<li><span>${esc(r.text)}</span><span class="meta">${esc(r.author)} · ${esc(r.updatedAt)}</span></li>`)
    .join('');
}

async function saveRecord() {
  const text = $('recText').value.trim();
  if (!text) return;
  try {
    const view = await api(`/api/workspaces/${ws}/records`, {
      method: 'PUT',
      body: { pageId, epoch: heldEpoch, text, author: `录入员@${pageId.slice(-4)}` },
    });
    $('recText').value = '';
    render(view, await api(`/api/workspaces/${ws}/status`));
    msg($('migMsg'), '已写入当前纪元', 'ok');
  } catch (e) {
    if (e.reload || e.code === 'EPOCH_SEALED' || e.code === 'EPOCH_STALE') {
      showStaleBanner(e.message);
      msg($('migMsg'), `保存被拒绝：${e.message}`, 'err');
    } else {
      msg($('migMsg'), `保存失败：${e.message}`, 'err');
    }
  }
}

async function doMigrate() {
  const tv = $('targetVersion').value.trim();
  try {
    const st = await api(`/api/workspaces/${ws}/migrate`, {
      method: 'POST',
      body: { targetVersion: tv ? Number(tv) : undefined },
    });
    await refresh();
    msg($('migMsg'), `迁移完成：${st.currentEpoch}（v${st.currentVersion}）`, 'ok');
  } catch (e) {
    await refresh();
    msg($('migMsg'), `迁移结果：${e.message}${e.code === 'MIGRATION_ACTIVE' ? '（未产生第二个候选）' : ''}`, e.code === 'MIGRATION_ACTIVE' ? 'warn' : 'err');
  }
}

async function doRecover() {
  try {
    const st = await api(`/api/workspaces/${ws}/recover`, { method: 'POST' });
    await refresh();
    msg($('migMsg'), `已按持久化阶段处理：当前 ${st.currentEpoch}，阶段 ${st.migration ? st.migration.phase : '空闲'}`, 'ok');
  } catch (e) {
    await refresh();
    msg($('migMsg'), `恢复失败：${e.message}`, 'err');
  }
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(refresh, 1500);
}

async function doAbort() {
  try {
    const st = await api(`/api/workspaces/${ws}/abort-migration`, { method: 'POST' });
    await refresh();
    msg($('migMsg'), st.migration ? '仍存在候选' : '候选已安全回收，回到完整旧纪元', 'ok');
  } catch (e) {
    msg($('migMsg'), `回收失败：${e.message}`, 'err');
  }
}

function reloadPage() {
  // 重开后 open 会拿到当前完整纪元并刷新围栏
  location.reload();
}

$('btnCreate').addEventListener('click', () => openWorkspace(true));
$('btnOpen').addEventListener('click', () => openWorkspace(false));
$('btnSave').addEventListener('click', saveRecord);
$('btnMigrate').addEventListener('click', doMigrate);
$('btnRecover').addEventListener('click', doRecover);
$('btnAbort').addEventListener('click', doAbort);
$('btnReload').addEventListener('click', reloadPage);

// 重开页面：自动重新登记围栏（sessionStorage 在标签页存活期间保留工作区名）
const lastWs = sessionStorage.getItem('ws');
if (lastWs) {
  $('wsName').value = lastWs;
  openWorkspace(false);
}
