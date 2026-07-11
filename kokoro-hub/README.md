# @kokoro/hub

skill/MCP 能力中台的**管理写面**（platform workspace 内，与 `@kokoro/user` 平级）。HUB-1 交付 skills 的启停 / 官方位 / 软删 / 配额查询 + 池查询 API；HUB-2 交付上传写面（preview→confirm 两步）+ 版本历史。

## 职责

- **写面权威**：per-user 启停偏好、官方位（`official_enabled` 全局上架 / `official_required` 恒注入）、软删（置 `deleted_at`，包体永存）。
- **上传写面**（HUB-2）：`preview`（解包校验清单——名称正则/保留字/大小/文件数/路径穿越/尖括号注入，常量对齐 agent 仓 `hub.py validate_package`——+ 归属冲突检测，不落任何东西）→ `confirm`（逐项发布允许部分成功：包体先落内容寻址 zip（ADR-009 yaml `hub` 节，local/s3 双档）再 Mongo upsert（`source=upload`，revision CAS）+ namespace 配额强制）。上传归属恒为 `scope==namespace`。
- **版本历史**：`skill_revisions` 附集合（append-only），真实写入时落一条；包体 zip 按 content_hash 永存=回滚零成本。
- **池查询**：`list_pool` 语义的 TS 收敛终点——official（`official_enabled` ∧ 用户偏好未关；`required` 恒含）+ 本 namespace 自有包（覆盖同名 official）。排序为运营序：`pinned` desc → `display_weight` desc → `name` asc；只出 `review_status=approved`（存量文档无字段 = 视为 approved，backfill 在读侧，不做存量迁移写）。
- **运营位**（HUB-4）：`display_weight`（排序权重，缺省 0）/ `pinned`（置顶，缺省 false）/ `category`（分类标签，null=未分类）。字段旁注记在 `src/contract/skill-curation-storage.ts`（待收编主仓 `contract/spec/storage.yaml` 单源）。
- **审核状态机**（HUB-4）：`review_status` 三态 `pending|approved|rejected`；V1 上传 confirm 真实写入自动 `approved`（字段先落，为后续人审留位）。
- **配额视图**：某 namespace 已上传包的包数 / 字节合计 vs env 配置上限；confirm 发布时按项强制。

## 读写分离边界（与 kokoro-agent）

hub 与 kokoro-agent **共享同一 Mongo**（`skills` / `skill_state` 两集合）：

- **hub 写**：本模块是管理写面的唯一入口。
- **agent 读**：`kokoro-agent/src/kokoro_agent/skills/hub.py` 的装配热路径（resolve_cards / read_body / 物化）直读同库，**每 run 不跨服务 RPC**（可用性解耦）。

双实现（Python 装配读路 + TS 管理写面）逐条同语义，是双实现收敛的第一步。契约单源 = 主仓 `contract/spec/storage.yaml`，`src/contract/storage.ts` 是其生成镜像（勿手改）。

## 契约面

| 方法 | 路由 | 说明 |
|---|---|---|
| GET | `/hub/skills/pool?namespace=` | 池查询（卡片含 name/description/content_hash/scope） |
| GET | `/hub/skills/quota?namespace=` | 配额视图（包数/字节合计 vs 上限） |
| POST | `/hub/skills/:scope/:name/enable` | 启用（body `{namespace}`） |
| POST | `/hub/skills/:scope/:name/disable` | 停用（`official_required` 拒关 → 409） |
| POST | `/hub/skills/:name/official-flags` | 官方位（body `{enabled?, required?}`） |
| DELETE | `/hub/skills/:scope/:name` | 软删 |
| POST | `/hub/skills/:scope/:name/curation` | 运营位（body `{display_weight?, pinned?, category?}` 至少一项；目标缺失/软删 → 404） |
| POST | `/hub/skills/:scope/:name/review` | 审核状态（body `{status: pending\|approved\|rejected}`；非 approved 即从池中消失） |
| POST | `/hub/skills/upload/preview` | 上传预检（multipart `file`+`namespace`，或 JSON `{namespace, zip_base64}`；zip 根下每目录=一个候选技能） |
| POST | `/hub/skills/upload/confirm` | 逐项发布（入参同上，另可选 `names` 挑选候选；单项 `published/unchanged/failed` 部分成功） |
| GET | `/hub/skills/:scope/:name/revisions` | 版本历史（append-only，revision 降序） |

上传 confirm 需配置包体存储：`KOKORO_WORKSPACE_CONFIG` 指向 ADR-009 存储 yaml（读其 `hub` 节，local/s3 双档；s3 凭据走 `KOKORO_WORKSPACE_S3_ACCESS_KEY/SECRET_KEY`）。未配置时 confirm 返回 503，其余面照常。

全部走 platform-kit envelope（`sendData`/`sendError`）+ Zod 边界校验；admin manifest 经 `hubAdminManifest` 声明，HUB-3 接入网关零改路由。

## 路线图（未做，刻意不贪）

- **灰度发布**：按 namespace 白名单/百分比放量新 revision。HUB-4 只落运营位与审核态字段；灰度需要"生效 revision 指针"与装配读路（agent hub.py）联动，等双实现读写语义再收敛一轮后做。
- **人审流**：`review_status` 字段与 `/review` API 已留位；接入人审时把 upsert 的自动 `approved` 改为 `pending` 即可，池过滤读路无需改动。

## 运行

```bash
cp .env.example .env      # 按需改 Mongo 连接
pnpm --filter @kokoro/hub start
```

## 测试

```bash
pnpm --filter @kokoro/hub test              # 单元
pnpm --filter @kokoro/hub test:integration  # 真 Mongo（27017）+ 真 minio（9100），库/桶随机命名，测毕清理
```
