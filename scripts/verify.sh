#!/bin/sh
# 验证流水线：单元测试 → 构建检查 → HTTP/API 冒烟（含旧写拒绝与中断恢复）。
# 任一步失败即以非零退出码退出；全部通过退出 0。
set -eu

cd "$(dirname "$0")/.."

echo "================ [1/3] 代码测试（node --test） ================"
node --test test/store.test.js

echo "================ [2/3] 构建检查 ================"
node scripts/build-check.js

echo "================ [3/3] 页面与健康 API/HTTP 冒烟 ================"
node test/smoke.mjs

echo "================ verify 全部通过 ================"
