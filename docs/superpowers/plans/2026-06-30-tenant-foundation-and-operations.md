# 多租户地基 + 运营控制台 实施计划

> 执行：每任务 TDD（先写失败测试→最小实现→绿→commit），逐任务推进，门禁全绿才进下一任务。设计依据 [tenant-model.md](../../platform/tenant-model.md) 与 [capabilities.md](../../platform/capabilities.md)。

**目标**：把 user/credit/payment 升级为 siteId 隔离的多租户，并在此之上建「站点感知的运营工作台」第一刀（用户360 + 发积分/退款/授予套餐/禁用 + 运营审计/理由/二次确认）。

**架构**：共享库行级隔离（siteId 列 + 全查询过滤）；RequestContext 边缘解析、header 透传、跨服务转发；admin 网关做运营守门人（认证/RBAC/审计/写代理），模块纯执行。

**技术栈**：Fastify 5 · Zod(.strict) · Prisma+MySQL · Vitest · TS NodeNext ESM · pnpm（**弃用 bun**）。

## 进度（2026-06-30）

- ✅ **Phase 0.1**：platform-kit `RequestContext`（principal 四类、`requireSite`、`contextHeaders` 透传）— 9 测试，已提交。
- ✅ **Phase 1**：user/credit/payment siteId 化（schema + 3 迁移 + 全链路 threading + payment→credit 转发）；5 dev 库重置为零漂移干净基线；user 25 / credit 45 / payment 29 / model 15 integration 全绿，已提交。
  - 实战修：integration 漏 `--no-file-parallelism` 假红；`user-admin`/`payment-admin` 测试共享 app 生命周期 bug。
- ✅ **Phase 2.1（部分=2a）**：网关 `/api/action` 写代理 + 理由必填 + `AuditSink` seam（manifest action 加可选 `route`/`method`）— 11 测试，已提交。
- ⬜ **剩余 Phase 2**：① 各模块 manifest 声明 action `route`（让 /api/action 端到端真通；注意 action id↔端点映射，如 refund 在 `/orders/:id/refund` 不在 /admin 下）② DB 持久化 AuditSink + OperatorAccount/Role（替换 ConsoleAuditSink）③ 平台 RBAC 强制 ④ 用户360 聚合端点 + 站点选择器 ⑤ 控制台 UI 升级为工作台（**上一版只读 UI 已被否，重建要走 frontend-design + Playwright 验**）。

## 全局约束

- 不硬编码 127.0.0.1；用 `KOKORO_*_BASE_URL` 服务名，本地经 env 覆盖。
- 钱/积分相关一律幂等 + 原子条件更新；唯一约束 siteId 化后为 `(siteId, …)`。
- 业务写缺 siteId → 拒绝（platform root 运营除外）。
- 迁移：scratch DB 生成 → deploy；存量数据回填 `default` 站点。
- 每文件对标项目 CLAUDE.md「完成标准」（零 any/cast、.strict、死代码清零、注释只写 WHY）。
- commit message 不带 Co-Authored-By。

---

## Phase 0：platform-kit 横切地基

### Task 0.1：RequestContext + 解析/守卫
**Files**: Create `kokoro-platform-kit/src/http/request-context.ts`；export from `src/index.ts`；Test `test/unit/request-context.test.ts`
**Interfaces（Produces）**:
- `RequestContext { requestId; siteId: string|null; principal: Principal; teamId?: string }`
- `Principal`（user/service/operator/system 联合，见 tenant-model §4）
- `readRequestContext(headers): RequestContext` —— 解析 `x-kokoro-request-id`/`x-kokoro-site-id`/`x-kokoro-principal`(JSON)，requestId 缺失则生成 UUID。
- `requireSite(ctx): string` —— siteId 为 null 抛 `SiteContextRequiredError`（→400 `context.site_required`）。
- `contextHeaders(ctx): Record<string,string>` —— 反向序列化，供跨服务转发。
- `forwardHeaders(headers): Record<string,string>` —— 从入站 headers 透传 x-kokoro-* 到出站。
**Tests**: principal 四类解析；缺 requestId 生成；缺 siteId → requireSite 抛错；round-trip contextHeaders∘readRequestContext。
**验收**: kit typecheck/lint/test 绿。

### Task 0.2：运营审计模型 + 网关审计存储 schema
**Files**: Create `kokoro-platform-admin/prisma/schema.prisma`（OperatorAccount/Role/AuditLog）；`kokoro-platform-admin/.env.example`(+`DATABASE_URL_ADMIN`)；Test 见 Phase 2。
**Schema**:
- `OperatorAccount{ id, email@unique, displayName, roleKey, status(active|disabled), createdAt, updatedAt }`
- `OperatorRole{ key@id, name, permissions Json }`（platform 作用域）
- `AuditLog{ id, actorOperatorId, action, moduleId, targetType, targetId, siteId?, reason?, before Json?, after Json?, result(ok|error), requestId, createdAt @@index([createdAt]) @@index([targetType,targetId]) }`
**验收**: prisma validate；scratch 生成迁移（数据步在 Phase 2 接线时一并跑）。

### Task 0.3：权限守卫工厂（网关侧）
**Files**: Create `kokoro-platform-admin/src/auth/rbac.ts`；Test `test/unit/rbac.test.ts`
**Interfaces**: `requirePermission(operator, perm): void`（缺权限抛 `PermissionDeniedError`→403）；`resolveOperator(headers)`（开发期可注入固定 superadmin，认证细节 Phase 3）。
**Tests**: superadmin 通过任意 perm；finance 仅 `payment.*`；readonly 无 mutation；缺权限 403。

---

## Phase 1：siteId 化（user → credit → payment）

> 每模块统一动作：① schema 加 siteId + 改唯一约束/索引 → ② scratch 生成迁移 + 回填 default 站 → ③ domain/repo/service/schemas/routes 串 siteId（入站从 `x-kokoro-site-id`，admin 显式传）→ ④ 测试全改 + 加 siteId 用例 → ⑤ 门禁绿 + 我串库跑 integration。

### Task 1.1：kokoro-user siteId 化
**Files**: `kokoro-user/prisma/schema.prisma`；`src/domain/{user,team,...}.ts`；`src/infrastructure/prisma/prisma-user-repository.ts`；`src/application/user-service.ts`；`src/interfaces/http/{schemas,routes,admin-routes}.ts`；migration 目录；`test/**`
**Schema 改动**:
- `User` +`siteId`；`@@unique([siteId, externalUserId])`、`@@unique([siteId, emailNormalized])`（emailNormalized 已 trim+lowercase）；删旧 `externalUserId@unique`。
- `Team` +`siteId`；`@@unique([siteId, slug])`、`@@unique([siteId, personalOwnerUserId])`。
- `Membership/Invite/ServiceAccount` +`siteId`（冗余，便于查询/约束）。
- `UserAuditLog` +`siteId` + `@@index([siteId, createdAt])`。
- 回填：迁移内对存量行 `siteId='default'`。
**逻辑**: `ensureUserWithPersonalTeam` 入参加 siteId（按 `(siteId, externalUserId)` upsert）；`/me/teams` 按 siteId 过滤；admin 列表 + disable/enable 端点 siteId 作用域（列表可平台级跨站，写按目标行 siteId）。HTTP 入站 siteId 取自 context header。
**Tests**: 同 externalUserId 跨两站 → 两个 User；个人团队 `(siteId,slug)` 不冲突；缺 siteId 写 → 400；既有用例补 siteId。
**验收**: typecheck/lint/unit 绿；我串库 integration 绿。

### Task 1.2：kokoro-credit siteId 化
**Files**: `kokoro-credit/prisma/schema.prisma`；`src/domain/*`；`prisma-credit-repository.ts`；`credit-service.ts`；`interfaces/http/{schemas,routes,admin-routes}.ts`；migration；`test/**`
**Schema**:
- `CreditAccount` +`siteId`；`@@unique([siteId, ownerKind, ownerId])`（删旧 `(ownerKind,ownerId)`）。
- `CreditLedgerEntry/CreditHold/UsageRecord` +`siteId`（冗余，继承 Account）。
- `PricingRule` **不加 siteId**（平台共享，tenant-model §3）。
- 回填 `siteId='default'`。
**逻辑**: `ensureAccount`/`grant`/`spend`/`hold`/`capture`/`release` 入参加 siteId；账户按 `(siteId,ownerKind,ownerId)` 解析；原子 SQL 的 WHERE 加 `siteId`；ledger/hold/usage 写入带 siteId。admin grant(by owner)/audit 带 siteId。
**Tests**: 同 owner 跨站独立账户/余额互不影响；原子并发 hold 在单站内仍精确；缺 siteId → 400；既有用例补 siteId。
**验收**: 同上 + 并发证明测试仍过。

### Task 1.3：kokoro-payment siteId 化 + 跨服务转发
**Files**: `kokoro-payment/prisma/schema.prisma`；`src/domain/*`；`prisma-payment-repository.ts`；`payment-service.ts`；`infrastructure/credit-grant-client.ts`；`interfaces/http/{schemas,routes,admin-routes}.ts`；`config/env.ts`；migration；`test/**`
**Schema**:
- `Plan` +`siteId`；`@@unique([siteId, key])`。
- `Order/Subscription/Refund` +`siteId`；Order/Sub 索引 `@@index([siteId, teamId, status])`。
- `PaymentEvent` **不加 siteId**（provider 驱动）。
- 回填 `siteId='default'`。
**逻辑**: `upsertPlan`/`createOrder`/`confirmOrder`/`refundOrder`/`grantPlanToTeam` 带 siteId；订单按 siteId 隔离。**跨服务转发**：`credit-grant-client` 的 ensure/grant/spend 调用补 `x-kokoro-site-id` + `x-kokoro-request-id` + principal header（用 kit `contextHeaders`）；credit 端据 header 解析 siteId 落账。
**Tests**: 同 key 套餐跨站独立；confirm 发积分落到 `(siteId,team)` 账户；refund 反扣同站账户；跨服务 header 带上（fake 断言）；缺 siteId → 400。
**验收**: 同上 + payment↔credit 串库 integration（confirm 后正确站点账户加分；refund 反扣）。

---

## Phase 2：运营控制台第一刀（用户360 + 4 操作 + 审计/理由/确认）

### Task 2.1：网关写操作代理 `/api/action` + 审计 + RBAC
**Files**: `kokoro-platform-admin/src/gateway.ts`（+`proxyAction`）；`src/server.ts`（+`POST /api/action`）；`src/audit.ts`；接 `prisma`(Task 0.2)；Test `test/unit/{gateway-action,audit}.test.ts`
**逻辑**: `POST /api/action {moduleId, actionId, route, method, body, reason}` →
1. `resolveOperator` + `requirePermission`(按 manifest action.requiredPermission)；
2. **reason 必填**校验（dangerMutation 强制）；
3. 校验 route+method ∈ 该 module manifest 声明的 action（SSRF/越权白名单）；
4. 带 `x-kokoro-site-id`(从请求) + context 转发到模块；
5. 落 `AuditLog`(actor/action/module/target/reason/result/requestId/siteId)；
6. 返回模块结果。
**Tests**: 无权限 403 不落执行；缺 reason 400；未声明 route 拒绝；成功落审计一条；模块 500 → 审计 result=error。

### Task 2.2：站点选择器 + 用户360 聚合端点
**Files**: `kokoro-platform-admin/src/gateway.ts`（+`getSites`、`getUser360`）；`src/server.ts`（+`GET /api/sites`、`GET /api/user360`）；Test
**逻辑**:
- `GET /api/sites` → 代理 site `/admin/sites`（站点选择器数据源）。
- `GET /api/user360?siteId=&query=` → 并行带 siteId 调：user(按 query 查用户/团队) + credit(该 owner 账户 audit) + payment(该 team 订单/订阅) → 拼 `{ identity, credit{account,ledger,holds,usage}, orders, subscriptions }`。
**Tests**: 聚合形状；某模块离线 → 该段 `{error}` 不拖垮整体；siteId 透传。
**依赖**: user 需补「按 email/id 查用户(带 siteId)」只读端点 → 子任务 2.2a（user 加 `GET /admin/users/lookup?siteId=&q=`）。

### Task 2.3：控制台 UI 升级为工作台
**Files**: `kokoro-platform-admin/public/index.html`（在现有中文化样式上扩展）
**交互**:
- 顶部站点选择器（来自 `/api/sites`）；选定后全局 siteId。
- 搜索框 → `/api/user360` → 一屏：身份卡 + 积分卡(余额/冻结/账本/用量) + 订单/订阅列表 + 状态。
- 右侧操作区按钮：**发积分 / 退款 / 授予套餐 / 禁用·启用**，各弹表单（含**理由必填** + **二次确认**），提交走 `POST /api/action`。
- 操作后刷新用户360；toast 显示审计已记。
**验收**: Playwright 走主路径（选站→搜用户→看全貌→发一次积分→刷新可见）+ 截图存 `docs/`。

### Task 2.4：并入草稿动作端点（siteId 版）
将 Phase 前草稿的 credit 发积分/audit、payment 退款/授予套餐、user 禁用启用、model 启停**并入 siteId 化版本**并接 manifest action 路由（之前 manifest 声明的 disable/grant/approve 等动作补齐对应后端 route）。
**验收**: 每动作经网关 `/api/action` 可达 + 落审计 + siteId 隔离。

---

## Phase 3（概要，后续单独成计划）

- 平台 RBAC 完整（OperatorAccount 认证 + 角色权限矩阵 + tenant RBAC 落 Role 表）。
- 概览仪表盘（收入/积分负债=已发未用/用量/各站对比）+ 异常告警。
- 审批流 maker-checker（大额退款/发积分二级审批）。
- 风控（限速/异常检测/批量禁用）。
- per-site feature flag / 配额；SiteModelPolicy（站点模型可见·分级）；开站向导；模型运维台；Swagger 各模块接入；真实支付渠道。

---

## 自检（spec 对标）

- 覆盖：siteId 化(user/credit/payment) ✓；用户360 ✓；4 操作 ✓；审计/理由/确认 ✓；站点感知 ✓；跨服务转发 ✓。model SiteModelPolicy/RBAC 完整/仪表盘 → 显式置于 Phase 3。
- 顺序：kit 地基 → 身份 → 计费 → 支付(含转发) → 网关守门 → 聚合 → UI → 并入。无前向依赖倒挂。
- 类型一致：RequestContext/Principal/contextHeaders 在 0.1 定义，Phase 1/2 复用同名。
