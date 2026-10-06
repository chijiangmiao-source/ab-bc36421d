# 野外实验站 · 离线记录（纪元迁移）

离线记录页升级索引结构时，停留在旧页面（旧纪元）的录入员不得把新记录写回旧纪元，
避免重新打开后混入两套结构。本项目用零依赖 Node.js 实现「纪元（epoch）+ 页面围栏 +
持久化迁移阶段机」，并提供 Docker Compose 的一次性 `verify` 服务。

## 核心模型

- **纪元（epoch）**：每个工作区有若干纪元，记录按纪元存放。`currentEpoch` 指向当前纪元。
  候选纪元在发布前 `complete=false`，**读取接口只返回当前纪元**——读取结果始终只可能来自
  「完整旧纪元」或「完整新纪元」，绝不暴露部分复制数据。
- **页面围栏（fence）**：每个已打开的标签页在服务端登记 `heldEpoch`。保存记录时必须携带
  自己持有的纪元：
  - 迁移进行中（copying/verifying/publishing）→ `409 EPOCH_SEALED`，旧纪元已封存；
  - 发布完成后旧页面迟到保存 → `409 EPOCH_STALE`。
  - 两种拒绝都带 `reload: true`，前端显示「请重新载入」横幅并停用编辑。
- **失效状态**：页面 `heldEpoch !== currentEpoch` 即 `invalid`，在状态接口和页面表格中展示；
  重新打开页面会刷新围栏并恢复有效。

## 迁移阶段机（全部持久化）

```
copying ──(复制完整、checksum 一致)──▶ verifying ──▶ publishing ──▶ committed ──▶ 清理标记
   │                                     │
   └──────── 中断：阶段落盘，重开后续用同一候选   └─ 校验失败：删除候选、安全回收，回到完整旧纪元
```

- 发起迁移时**候选纪元 id 先原子落盘**（copying），之后逐条复制并逐条落盘，真实呈现中断现场。
- 并发/重复发起：本进程内已有推进者时返回 `409 MIGRATION_ACTIVE`，**不会创建第二个候选**。
- 复制/校验/发布之间页面或进程关闭：后来打开的页面调 `POST /recover`，
  依据磁盘上的持久化阶段续用同一候选（复制幂等补齐 → 校验 → 原子发布），或在校验失败时安全回收。
- 发布是单次原子文件写入（临时文件 `rename`）：`currentEpoch` 切换与 `committed` 标记同生共死；
  即使发布后、清理标记前崩溃，重开也只能读到完整新纪元，恢复仅清理标记而不新建候选。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/workspaces` | 建立工作区 `{name, label?}` |
| GET | `/api/workspaces/:ws` | 读取当前完整纪元与记录 |
| GET | `/api/workspaces/:ws/status` | 当前纪元、迁移阶段、持有围栏页面及失效状态 |
| POST | `/api/workspaces/:ws/pages/:page/open` | 打开/刷新页面围栏 |
| POST | `/api/workspaces/:ws/pages/:page/close` | 关闭页面 |
| PUT | `/api/workspaces/:ws/records` | 保存 `{pageId, epoch, text, author?}` |
| DELETE | `/api/workspaces/:ws/records` | 删除 `{pageId, epoch, id}` |
| POST | `/api/workspaces/:ws/migrate` | 发起/续用迁移 `{targetVersion?, fault?}` |
| POST | `/api/workspaces/:ws/recover` | 按持久化阶段恢复 |
| POST | `/api/workspaces/:ws/abort-migration` | 手动安全回收候选 |
| GET | `/healthz` | 健康响应 |

页面：浏览器打开 `http://localhost:8080/`，可在两个标签页打开同一工作区做并发验收。

## 运行

```bash
# 本地（零依赖，Node >= 20）
node server/main.js            # 默认 PORT=8080 DATA_DIR=.data

# Compose
docker compose up app
```

## 验证

```bash
# 编排内：app 健康后运行一次性 verify 服务，结束自行退出并以退出码报告结果
docker compose run --rm verify

# 或本地等价流水线：单元测试 → 构建检查 → API/HTTP 冒烟
sh scripts/verify.sh
```

`verify` 覆盖：

1. **代码测试**（`node --test`，10 项）：读写、旧写拒绝、在途封存、并发不产生第二候选、
   复制中断、校验失败安全回收、发布后崩溃恢复、页面失效与恢复一致性；
2. **构建检查**：所有 JS `node --check`、页面资源引用完整；
3. **API/HTTP 冒烟**：`/healthz`、`/`、`/app.js`、`/style.css`，以及两个页面对同一工作区的
   旧写拒绝、复制中断重开不展示部分数据、真实进程重启后续用同一候选、发布后纪元/记录/失效状态一致。

故障注入仅在 `ALLOW_FAULT_INJECTION=1` 时开放（`failAfterCopy` / `slowMs` / `crashAfterPublish`），
供中断与恢复测试使用。
