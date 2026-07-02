# kokoro-site 单仓完善技术方案

> 状态：已批准按单子仓推进。本文只覆盖 `kokoro-site`，不展开 `kokoro-user`、`kokoro-payment`、`kokoro-credit`、`kokoro-model` 的实现。

## 1. 目标

把 `kokoro-site` 从“能创建和查询站点”推进到“租户根仓的生产级闭环”：

- DB model 明确软删除规则，业务删除不硬删。
- 所有读写默认排除 deleted 数据，只有审计/恢复/后台诊断显式 includeDeleted。
- `site.id = site-<key>` 继续作为全平台租户主键。
- 站点生命周期可阻断下游；`active` 是唯一可消费状态。
- admin manifest、route schema、前端表单字段不再三处手写漂移。
- 每个动作先有失败测试，再实现，再跑门禁。

成功标准：`kokoro-site` 自己的 schema、repository、service、HTTP/admin route、admin 契约、测试、文档闭合后，再进入下一个子仓。

## 2. 范围

本轮只改 `kokoro-site` 及必要的共享契约类型：

- `kokoro-site/prisma/schema.prisma`
- `kokoro-site/src/domain/*`
- `kokoro-site/src/application/site-service.ts`
- `kokoro-site/src/infrastructure/prisma/prisma-site-repository.ts`
- `kokoro-site/src/interfaces/http/*`
- `kokoro-site/src/interfaces/admin/*`
- `kokoro-site/test/unit/*`
- `kokoro-site/test/integration/*`
- `kokoro-platform-kit/src/admin/*` 中仅限契约 schema 的向后兼容扩展
- `kokoro-admin-web` 只允许消费新的 site admin contract；不做全后台重写

不在本轮做：

- 不改 user/payment/credit/model 的 DB schema。
- 不做全平台 contract 包抽取。第二个子仓开始重复时再抽 `@kokoro/platform-contract`。
- 不做支付渠道、notification、runtime 用量上报。
- 不做 UI 视觉重设计。
- 不清理历史测试数据，除非测试隔离必须。

## 3. 当前取证

### 3.1 DB 缺软删除基线

`kokoro-site/prisma/schema.prisma:11` 开始定义 `Site`，现有字段只有 `status/createdAt/updatedAt`，没有 `deletedAt/deletedBy/deleteReason`。

`SiteDomain`、`SiteApp`、`SitePolicy`、`SiteBrandConfig`、`SiteSeoConfig`、`SiteFeatureFlag` 也没有软删除字段：

- `kokoro-site/prisma/schema.prisma:32`
- `kokoro-site/prisma/schema.prisma:48`
- `kokoro-site/prisma/schema.prisma:65`
- `kokoro-site/prisma/schema.prisma:80`
- `kokoro-site/prisma/schema.prisma:99`
- `kokoro-site/prisma/schema.prisma:120`

现有唯一约束会影响软删除后重建：

- `Site.key @unique`：`kokoro-site/prisma/schema.prisma:13`
- `SiteDomain.host @unique`：`kokoro-site/prisma/schema.prisma:35`
- `SiteApp(siteId, appKey, surface)`：`kokoro-site/prisma/schema.prisma:60`
- `SitePolicy(siteId, key)`：`kokoro-site/prisma/schema.prisma:75`
- `SiteFeatureFlag(siteId, key)`：`kokoro-site/prisma/schema.prisma:130`

结论：软删除字段不能只加 `deletedAt`，还必须处理“删除后是否允许复用 key/host”的业务规则。

### 3.2 Repository 已有关键契约，但默认列表不过滤 deleted

`upsertSite` 已把 `site.id` 固定为 `site-<key>`，见 `kokoro-site/src/infrastructure/prisma/prisma-site-repository.ts:22` 到 `:31`。

`normalizeKey` 已做 trim/lower，见 `kokoro-site/src/infrastructure/prisma/prisma-site-repository.ts:269` 到 `:272`。

`resolveSiteContext` 已要求 domain 和 site 都 active，见 `kokoro-site/src/infrastructure/prisma/prisma-site-repository.ts:157` 到 `:183`。

`resolveSiteActive` 已给下游提供 active 校验，见 `kokoro-site/src/infrastructure/prisma/prisma-site-repository.ts:202` 到 `:205`。

后台列表现在直接 `findMany`，未过滤 deleted：

- `listAdminSites`：`kokoro-site/src/infrastructure/prisma/prisma-site-repository.ts:217`
- `listAdminSiteDomains`：`kokoro-site/src/infrastructure/prisma/prisma-site-repository.ts:226`
- `listAdminSiteApps`：`kokoro-site/src/infrastructure/prisma/prisma-site-repository.ts:235`
- `listAdminSitePolicies`：`kokoro-site/src/infrastructure/prisma/prisma-site-repository.ts:244`
- `listAdminSiteFeatureFlags`：`kokoro-site/src/infrastructure/prisma/prisma-site-repository.ts:253`

结论：软删除必须落在 repository 默认查询，而不是靠前端过滤。

### 3.3 HTTP schema 严格，但站点身份来源仍有双模式

写入 schema 使用 Zod `.strict()`，例如 `upsertSiteRequestSchema` 在 `kokoro-site/src/interfaces/http/schemas.ts:14` 到 `:23`。

feature flag 的 list 允许 query 优先、header 回退，见 `kokoro-site/src/interfaces/http/routes.ts:200` 到 `:213`。

结论：本轮内 site 子仓统一规则：内部/admin 写接口 body 可携带 `siteId`，消费侧读接口以 `x-kokoro-site-id` 为权威。若同时传 query 和 header，必须相等，否则 400。

### 3.4 Admin manifest 和 UI 表单仍分离

admin route 按 manifest 注册 list，见 `kokoro-site/src/interfaces/http/admin-routes.ts:6` 到 `:34`。

manifest 动作只声明 action/route/permission，不带请求 schema 和表单字段：

- `kokoro-site/src/interfaces/admin/manifest.ts:36`
- `kokoro-site/src/interfaces/admin/manifest.ts:52`
- `kokoro-site/src/interfaces/admin/manifest.ts:68`
- `kokoro-site/src/interfaces/admin/manifest.ts:84`
- `kokoro-site/src/interfaces/admin/manifest.ts:100`

结论：只继续手写 manifest 会让 route、Zod schema、admin-web form 三处漂移。本轮要把 site 的 admin contract 改成单源。

## 4. 设计决策

### D1. 单仓完成后再推进

`kokoro-site` 完成前，不并行修改其它业务子仓。其它子仓只允许读代码取证。

理由：site 是租户根，siteId、生命周期、软删除语义会被所有下游继承。先把根仓打透，后续子仓按模板迁移。

### D2. 业务删除一律软删除

业务 API 禁止 `delete` / `deleteMany`。删除动作只能写入：

- `deletedAt DateTime?`
- `deletedBy String?`
- `deleteReason String?`

状态字段保留原业务生命周期，例如 `Site.status = active/suspended/archived`。`deletedAt != null` 表示资源不再参与业务，不与 `status` 混用。

例外：

- test helper 清库可以 `deleteMany`。
- 一次性迁移脚本可硬删明确标记的测试垃圾。
- append-only 表不提供业务删除，只能补记冲正/作废/匿名化。

### D3. 唯一约束按资源分级处理

`Site.key` 和 `SiteDomain.host` 是全局身份，不允许删除后直接复用。软删除后再次创建同 key/host 必须返回可读错误，提示先恢复或换 key。

子资源可按业务需要恢复，不在本轮支持删除后复用唯一键：

- `SiteApp(siteId, appKey, surface)`
- `SitePolicy(siteId, key)`
- `SiteFeatureFlag(siteId, key)`

这样避免 MySQL/Prisma 对“部分唯一索引”的兼容复杂度。本轮先做可审计、可恢复、不可复用。确需复用时再设计唯一键版本化。

### D4. Admin contract 单源先放在 site 子仓

新增 `kokoro-site/src/interfaces/admin/site-admin-contract.ts`，它同时定义：

- resource id
- list route
- action id
- action route
- requiredPermission
- action kind
- Zod request schema
- admin form 字段描述
- optionsFrom 数据源

`manifest.ts` 从 contract 派生，不再手写另一份。`admin-routes.ts` 从同一 contract 注册 list/action。`kokoro-admin-web` 的 site 表单从 `/api/manifests` 或新 `/api/admin-contracts/site` 消费字段描述。

第二个子仓开始复用后，再把 contract schema 抽进 `kokoro-platform-kit` 或独立 workspace 包。第一仓不提前抽象。

### D5. 成熟件使用边界

本轮允许并应该使用成熟件：

- Prisma migration/client
- Zod runtime contract
- Fastify route schema
- Ant Design Pro 表格/表单消费 contract

本轮不引入新大型服务框架。原因：`kokoro-site` 的主要问题是契约漂移和数据语义缺口，不是 HTTP 框架能力不足。

## 5. 目标数据模型

本节每个字段和索引都必须保留设计理由。后续实现 PR 不能只写“加字段/加索引”，必须说明它服务哪条业务链路、避免什么错误。

### 5.1 Site

新增字段：

```prisma
deletedAt    DateTime?
deletedBy    String?
deleteReason String?
```

新增索引：

```prisma
@@index([status, deletedAt])
@@index([deletedAt])
```

`key` 继续唯一。创建时 normalize key；若已存在且 deleted，返回 `site.deleted` 业务错误，不自动覆盖。

设计理由：

- `deletedAt` 是业务可见性边界。站点被删除后必须立刻从解析、列表、下游 active 校验中消失，但记录仍要留给审计、恢复和对账。
- `deletedBy/deleteReason` 是运营责任边界。删除租户是高风险动作，必须知道是谁、为什么，而不是只看到状态变了。
- `status` 和 `deletedAt` 分离。`suspended/archived` 是生命周期状态，`deletedAt` 是退出业务流通；混用会导致“暂停站点”和“删除站点”在下游不可区分。
- `key` 保持全局唯一且删除后不可复用，是为了保证 `site.id = site-<key>` 永远稳定。允许复用会让历史订单、积分、审计在同一个 siteId 下指向不同租户。
- `@@index([status, deletedAt])` 服务 admin 列表和 active 过滤；`@@index([deletedAt])` 服务恢复/诊断视图。

### 5.2 SiteDomain

新增字段：

```prisma
deletedAt    DateTime?
deletedBy    String?
deleteReason String?
```

新增索引：

```prisma
@@index([siteId, status, deletedAt])
@@index([deletedAt])
```

`host` 继续唯一。删除后不可被其它 site 绑定，必须先恢复或换 host。

设计理由：

- 域名是外部入口，删除后仍不可被其它站点抢占，避免旧链接、SEO、回调、证书或缓存流量被错误导向新租户。
- `deletedAt` 让域名从解析链路消失，`deleteReason` 让运营能解释为什么一个 host 不再解析。
- `@@index([siteId, status, deletedAt])` 服务“列出某站可用域名”和解析前检查；`@@index([deletedAt])` 服务后台恢复入口。

### 5.3 SiteApp / SitePolicy / SiteBrandConfig / SiteSeoConfig / SiteFeatureFlag

全部新增同样的软删除字段和 `deletedAt` 索引。

列表默认加 `deletedAt: null`。`resolveSiteContext`、`resolveFlags` 必须只看未删除资源。

设计理由：

- 子资源必须跟随软删除规则，否则 site 已收口但 app/policy/flag 仍被解析链路读到，会形成“幽灵配置”。
- 子资源的业务状态仍保留为 `active/disabled` 或 `enabled`；软删除只负责从业务流通中移除。
- 本轮不做删除后唯一键复用，是为了保持实现可验证。复用需要版本化唯一键或历史别名策略，属于后续独立设计。

## 5.4 DB 命名和迁移规范

目录命名：

- Prisma schema 固定在 `kokoro-site/prisma/schema.prisma`。
- 迁移目录使用 Prisma 默认格式：`kokoro-site/prisma/migrations/YYYYMMDDHHMMSS_<kebab-or-snake-summary>/`。
- 迁移名必须描述业务，不写含糊词。例如 `20260702090000_add_site_soft_delete_fields`，不要写 `update_schema`。

字段命名：

- Prisma model 字段继续使用 camelCase：`deletedAt`、`deletedBy`、`deleteReason`。
- DB 表名继续用现有 `@@map("site_*")` 风格，不改历史表名。
- 不引入 `isDeleted`。布尔字段无法表达删除时间、操作者和恢复排序。

生成规则：

- 改 schema 后必须运行 `pnpm --filter @kokoro/site db:generate`。
- migration、generated client、测试必须在同一任务里完成验证，不能只提交 schema。

## 6. Repository 设计

新增类型：

```ts
export interface DeleteSiteResourceInput {
  id: string;
  deletedBy?: string;
  reason: string;
}

export interface RestoreSiteResourceInput {
  id: string;
}

export interface ListSiteResourcesOptions {
  includeDeleted?: boolean;
}
```

新增 repository 方法：

```ts
deleteSite(input: DeleteSiteResourceInput): Promise<Site>;
restoreSite(input: RestoreSiteResourceInput): Promise<Site>;
deleteSiteDomain(input: DeleteSiteResourceInput): Promise<SiteDomain>;
restoreSiteDomain(input: RestoreSiteResourceInput): Promise<SiteDomain>;
```

本轮只要求 `Site` 和 `SiteDomain` 提供删除/恢复动作，因为它们是 L1 租户闭环的关键资源。`SiteApp/SitePolicy/SiteFeatureFlag` 先只补软删除字段和默认过滤；动作在后续小步补。

所有现有 list 方法改成：

- 默认 `where: { deletedAt: null }`
- `includeDeleted: true` 才不加过滤

`resolveSiteActive(siteId)` 必须同时检查：

```ts
site !== null && site.deletedAt === null && site.status === "active"
```

`resolveSiteContext` 必须检查：

- domain 未删除
- domain active
- site 未删除
- site active
- app 未删除
- app active

## 7. HTTP/Admin 契约

### 7.1 保留的写接口

- `POST /sites/upsert`
- `POST /site-domains/upsert`
- `POST /site-apps/upsert`
- `POST /site-policies/upsert`
- `POST /site-feature-flags/upsert`

这些接口必须拒绝写入 deleted 资源。若 key/host 命中 deleted 资源，返回 409：

```json
{
  "error": {
    "code": "site.deleted",
    "message": "站点已删除，请先恢复或更换 key"
  }
}
```

### 7.2 新增动作接口

```http
POST /sites/:id/delete
POST /sites/:id/restore
POST /site-domains/:id/delete
POST /site-domains/:id/restore
```

delete body：

```ts
z.object({
  reason: z.string().min(1),
  deletedBy: z.string().min(1).optional()
}).strict()
```

restore body：

```ts
z.object({}).strict()
```

删除是幂等的：

- 第一次删除：200，返回 deleted 资源。
- 重复删除：200，返回现有 deleted 资源，不改 `deletedAt`。
- 不存在：404。

恢复是幂等的：

- 已删除：200，清空软删除字段。
- 未删除：200，返回资源。
- 不存在：404。

### 7.3 Manifest/contract 规则

site manifest 必须从 site admin contract 派生，禁止手写漂移。

新增动作：

- `sites.delete`：`dangerMutation`，需要 `site.delete`
- `sites.restore`：`mutation`，需要 `site.write`
- `domains.delete`：`dangerMutation`，需要 `siteDomain.delete`
- `domains.restore`：`mutation`，需要 `siteDomain.write`

所有 `dangerMutation` 必须要求 reason，继续走网关审批/审计。

## 7.4 核心业务链路和设计理由

### 链路 A：创建站点

`POST /sites/upsert` → normalize key → 生成确定性 `site-<key>` → 写 `Site` → admin list 可见。

设计理由：

- normalize key 放在 repository，保证 HTTP、admin、测试、未来内部调用都走同一规则。
- `site.id = site-<key>` 是跨服务身份契约，不允许由 DB cuid 随机生成。
- deleted site 不允许 upsert 覆盖，是为了避免“删除租户后同 key 新租户继承旧账务/审计”。

### 链路 B：解析站点上下文

`GET /site-context/resolve` → host normalize → 找未删除 active domain → 找未删除 active site → 找未删除 active app → 返回 context。

设计理由：

- 解析链路是 C 端/runtime 的入口，必须比 admin list 更严格。
- 只要 domain/site/app 任一层 deleted 或非 active，就返回 404，避免暂停/删除资源继续被消费。
- app 过滤必须进入 DB 查询条件，不能在返回后前端过滤。

### 链路 C：下游 active 校验

`GET /sites/:siteId/active` → site 存在 + `deletedAt == null` + `status == active` 才返回 true。

设计理由：

- payment/credit/model 等下游只需要一个稳定布尔判断，不应该复制 site 生命周期规则。
- deleted 和 suspended 都必须阻断下游记账/消费，但原因留在 site 仓查询和审计里。
- 该接口是跨仓状态贯穿的第一个模板，后续 user/team active 校验按同样模式实现。

### 链路 D：删除站点

admin action `sites.delete` → gateway RBAC/site scope/审批/审计 → `POST /sites/:id/delete` → repository 写软删除字段 → 解析和下游 active 立即 false。

设计理由：

- 删除必须经过 gateway，因为它是危险运营动作，需要 reason、审批和审计。
- 删除不级联硬删子资源。保留子资源能支持恢复和审计，但所有消费查询必须由 site 的 deleted 状态阻断。
- 重复删除幂等，避免审批重试或网络重放造成错误。

### 链路 E：恢复站点

admin action `sites.restore` → gateway 审计 → `POST /sites/:id/restore` → 清空软删除字段 → 仍按原 `status` 决定是否 active。

设计理由：

- 恢复不自动改成 active。删除前如果是 suspended，恢复后仍 suspended，避免恢复动作绕过生命周期治理。
- 恢复只恢复 business visibility，不重写 key、id、createdAt。

### 链路 F：删除/恢复域名

admin action `domains.delete/restore` → gateway → `POST /site-domains/:id/delete|restore` → 解析链路立即变化。

设计理由：

- 域名删除影响外部入口，比普通配置更高风险，必须单独成为 action。
- host 删除后不可复用，避免旧流量落到错误站点。

## 8. Admin Web 消费规则

`kokoro-admin-web` 本轮只改 site 页面的 contract 消费，不重写其它模块。

目标：

- site 页不再从本地 `RESOURCE_FORMS["site:*"]` 读取字段。
- site 页从 gateway 暴露的 contract 获取字段、action、schema hints。
- 其它模块仍可暂时使用旧 `RESOURCE_FORMS`，但不得新增旧模式。

过渡方式：

1. `kokoro-platform-admin` 聚合 site manifest 时保留旧字段，避免现有 UI 断。
2. 增加 `formFields` 可选字段。
3. admin-web 优先使用 `formFields`，缺失时回退旧 `RESOURCE_FORMS`。
4. site 子仓完成后删除 `RESOURCE_FORMS` 中 `site:*` 条目。

## 9. 测试策略

必须先写失败测试。

### 9.1 DB/repository integration

新增或扩展 `kokoro-site/test/integration/site-repository.integration.test.ts`：

- 创建 site 后软删除，`listSites()` 不返回。
- `listAdminSites()` 默认不返回 deleted。
- `listAdminSites({ includeDeleted: true })` 返回 deleted。
- deleted site 的 `resolveSiteActive(siteId)` 返回 false。
- deleted domain 的 `resolveSiteContext(host)` 返回 null。
- 重复 delete 不改变 `deletedAt`。
- restore 后资源重新出现在列表。
- deleted key 再 upsert 返回业务错误，不静默覆盖。

### 9.2 HTTP integration

扩展 `kokoro-site/test/integration/site-http.test.ts`：

- `POST /sites/:id/delete` 缺 reason 返回 400。
- delete 后 `GET /sites/:id/active` 返回 `{active:false}`。
- delete 后 `GET /sites` 不返回该 site。
- restore 后重新返回。
- deleted host 解析返回 404。

现有测试已经覆盖 active 校验、upsert/list、context resolve、strict schema，见 `kokoro-site/test/integration/site-http.test.ts:40`、`:56`、`:106`、`:141`。

### 9.3 Admin contract tests

新增 `kokoro-site/test/unit/site-admin-contract.test.ts`：

- manifest 从 contract 派生。
- 每个 action 都有 route、schema、permission。
- 每个 dangerMutation 都有 reason 字段要求。
- 每个 resource 的 list route 都能在 `admin-routes.ts` 注册。
- 不允许声明无 route 的假动作。

## 10. 门禁

每个 schema 变更后必须运行：

```bash
pnpm --filter @kokoro/site db:generate
pnpm --filter @kokoro/site typecheck
pnpm --filter @kokoro/site test
pnpm --filter @kokoro/site test:integration
```

如果改了 `platform-kit` contract schema，还要运行：

```bash
pnpm --filter @kokoro/platform-kit typecheck
pnpm --filter @kokoro/platform-kit test
```

如果改了 admin-web site contract 消费，还要运行：

```bash
cd kokoro-admin-web
npx tsc --noEmit
npx eslint .
npx vitest run
npx next build
```

验收时必须记录真实退出码，不能用 `tail` 或只看日志片段判断成功。

## 11. 实施顺序

实现时必须沿以下目录和文件命名执行；新增文件若不在清单内，先补方案再写代码。

### Phase 1：site 软删除 DB 基线

1. 写 repository 失败测试。
2. 改 Prisma schema。
3. `pnpm --filter @kokoro/site db:generate`。
4. 实现 repository 默认过滤和 delete/restore。
5. 跑 site integration。

### Phase 2：HTTP 删除/恢复接口

1. 写 HTTP 失败测试。
2. 增加 Zod schema。
3. 增加 service 方法。
4. 增加 routes。
5. 跑 HTTP integration。

### Phase 3：site admin contract 单源

1. 写 admin contract 失败测试。
2. 新增 site admin contract。
3. manifest 从 contract 派生。
4. admin routes 从 contract 注册。
5. 跑 unit + typecheck。

### Phase 4：admin-web 只迁 site 表单

1. 给 gateway 暴露 contract 字段。
2. admin-web site 页优先消费 contract。
3. 删除 `RESOURCE_FORMS` 的 `site:*` 旧条目。
4. 跑 admin-web typecheck/build。

### Phase 5：界面闭环验证

用 admin-web 完成：

1. 新建 site。
2. 绑定 domain。
3. 删除 site，确认列表消失，active 校验 false。
4. 恢复 site，确认列表恢复。
5. 删除 domain，确认 context resolve 404。
6. 恢复 domain，确认 context resolve 200。

## 11.1 目录和文件命名

TypeScript 源码命名：

- domain 类型文件按业务实体用 kebab-case：`site-deletion.ts`、`site-admin-contract.ts`。
- repository 实现继续放 `src/infrastructure/prisma/`，文件名保持 `prisma-site-repository.ts`，不新增平行 repository。
- HTTP schema 仍放 `src/interfaces/http/schemas.ts`。如果文件超过可读范围，再拆成 `src/interfaces/http/site-delete-schemas.ts`，不得把 schema 塞进 routes。
- admin contract 放 `src/interfaces/admin/site-admin-contract.ts`。
- manifest 保持 `src/interfaces/admin/manifest.ts`，但内容从 contract 派生。

测试命名：

- repository 集成测试继续放 `test/integration/site-repository.integration.test.ts`。
- HTTP 集成测试继续放 `test/integration/site-http.test.ts`。
- 新增 admin contract 单测：`test/unit/site-admin-contract.test.ts`。
- 新增纯领域单测才放 `test/unit/site-deletion.test.ts`。

文档命名：

- 技术方案放 `docs/platform/tech/YYYY-MM-DD-kokoro-site-<topic>.md`。
- 契约文档后续放 `docs/platform/contract/site.md`。
- 测试矩阵后续放 `docs/platform/test/site.md`。

脚本命名：

- 本仓是 TypeScript 主栈，默认不新增 Python 脚本。
- 若确实需要一次性 Python 工具，必须放 `scripts/` 或 `tmp/`，文件名用 lower_snake_case，例如 `verify_site_soft_delete.py`，并在文件头说明为什么不能用现有 TS/pnpm 工具完成。
- 临时 Python 脚本不得进入业务源码目录。

## 12. 禁止事项

- 禁止同时改多个业务子仓。
- 禁止业务 API 硬删除。
- 禁止新增无 route 的 manifest action。
- 禁止前端新增本地手写 `RESOURCE_FORMS["site:*"]`。
- 禁止为了快速通过测试在下游散落过滤逻辑；默认过滤必须在 repository。
- 禁止把 `deletedAt` 和 `status=archived/suspended` 混为同一个语义。
- 禁止把 schema 改完不运行 `db:generate`。
- 禁止记录参考项目名称、路径或来源。
- 禁止新增没有设计理由的 DB 字段、索引、目录或文件。
- 禁止用 `utils.ts`、`helpers.ts`、`types.ts` 这类泛名承载新核心逻辑；名称必须表达业务职责。

## 13. 对后续子仓的输出

`kokoro-site` 完成后，向下一个子仓交付的是模板，不是未完成想法：

- 软删除字段和查询模式。
- admin contract 单源模式。
- dangerMutation reason/审批模式。
- route/schema/manifest/form 的一致性测试。
- 门禁命令和 E2E 截图。

下一仓建议：`kokoro-user`。原因是 user/team 的 disable/delete 会直接影响 payment/credit 记账前 owner active 校验。
