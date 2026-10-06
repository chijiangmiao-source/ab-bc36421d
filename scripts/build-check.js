// 构建检查：所有 JS 通过 node --check（ESM 语法解析），前端资源完整引用。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = ['server/store.js', 'server/main.js', 'public/app.js', 'test/store.test.js', 'test/smoke.mjs'];
let failed = 0;

for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', join(root, f)], { stdio: 'pipe' });
    const src = readFileSync(join(root, f), 'utf8');
    console.log(`syntax ok: ${f} (${src.length} bytes)`);
  } catch (e) {
    failed++;
    console.error(`syntax FAIL: ${f}:\n${e.stderr?.toString() || e.message}`);
  }
}

const html = readFileSync(join(root, 'public', 'index.html'), 'utf8');
for (const asset of ['/app.js', '/style.css']) {
  if (!html.includes(asset)) {
    failed++;
    console.error(`index.html 缺少资源引用 ${asset}`);
  }
}

if (failed) {
  console.error(`build-check: ${failed} 项失败`);
  process.exit(1);
}
console.log('build-check: 通过');
