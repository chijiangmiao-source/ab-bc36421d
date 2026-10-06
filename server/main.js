// 零依赖 HTTP 服务：工作区/页面围栏/记录/迁移/恢复 API + 静态页面。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { DataStore, StoreError } from './store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, '..', 'public');
const DATA_DIR = process.env.DATA_DIR || join(__dirname, '..', '.data');
const PORT = Number(process.env.PORT || 8080);

export const store = new DataStore(DATA_DIR);
const faultEnabled = process.env.ALLOW_FAULT_INJECTION === '1';

const json = (res, code, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1_000_000) reject(new StoreError('BODY_TOO_LARGE', '请求体过大', 413));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new StoreError('BAD_JSON', '请求体不是合法 JSON', 400));
      }
    });
  });

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // /api/workspaces/:ws/...
  const method = req.method;

  if (parts[0] !== 'api') return false;

  if (method === 'POST' && parts[1] === 'workspaces' && parts.length === 2) {
    const body = await readBody(req);
    const name = String(body.name || '').trim();
    if (!/^[a-z0-9][a-z0-9-_]{0,63}$/i.test(name)) throw new StoreError('BAD_NAME', '工作区名称不合法', 400);
    return json(res, 201, await store.createWorkspace(name, { label: body.label }));
  }

  if (method === 'GET' && parts[1] === 'workspaces' && parts.length === 3) {
    return json(res, 200, await store.read(parts[2]));
  }
  if (method === 'GET' && parts[1] === 'workspaces' && parts[3] === 'status') {
    return json(res, 200, await store.status(parts[2]));
  }

  // /api/workspaces/:ws/pages/:page/open|close
  if (parts[3] === 'pages' && parts[5] === 'open' && method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    return json(res, 200, await store.openPage(parts[2], parts[4], { label: body.label }));
  }
  if (parts[3] === 'pages' && parts[5] === 'close' && method === 'POST') {
    return json(res, 200, await store.closePage(parts[2], parts[4]));
  }

  // /api/workspaces/:ws/records  body: { pageId, epoch, text, author, id }
  if (parts[3] === 'records' && method === 'PUT' && parts.length === 4) {
    const body = await readBody(req);
    return json(
      res,
      200,
      await store.putRecord(parts[2], String(body.pageId), String(body.epoch), body),
    );
  }
  if (parts[3] === 'records' && method === 'DELETE' && parts.length === 4) {
    const body = await readBody(req);
    return json(res, 200, await store.deleteRecord(parts[2], String(body.pageId), String(body.epoch), String(body.id)));
  }

  // /api/workspaces/:ws/migrate  body: { targetVersion, fault? }
  if (parts[3] === 'migrate' && method === 'POST' && parts.length === 4) {
    const body = await readBody(req);
    const fault = faultEnabled && body.fault ? body.fault : null;
    return json(res, 200, await store.migrate(parts[2], body.targetVersion ? Number(body.targetVersion) : undefined, fault));
  }
  if (parts[3] === 'recover' && method === 'POST' && parts.length === 4) {
    return json(res, 200, await store.recover(parts[2]));
  }
  if (parts[3] === 'abort-migration' && method === 'POST' && parts.length === 4) {
    return json(res, 200, await store.abortMigration(parts[2]));
  }

  throw new StoreError('NOT_FOUND', '未知 API 路径', 404);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css' };

async function handleStatic(req, res, url) {
  let path = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = normalize(join(PUBLIC, path));
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[file.slice(file.lastIndexOf('.'))] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}

export function createApp() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, uptime: process.uptime(), dataDir: DATA_DIR }));
      }
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (req.method === 'GET') return await handleStatic(req, res, url);
      throw new StoreError('NOT_FOUND', 'not found', 404);
    } catch (err) {
      if (err instanceof StoreError) return json(res, err.status, { error: err.code, message: err.message, ...err });
      // eslint-disable-next-line no-console
      console.error(err);
      json(res, 500, { error: 'INTERNAL', message: String(err.message || err) });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`field-station listening on http://0.0.0.0:${PORT} (data: ${DATA_DIR})`);
  });
}
