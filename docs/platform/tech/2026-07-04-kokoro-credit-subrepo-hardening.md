# kokoro-credit 单仓完善技术方案

> 状态：方案锁定稿。本文只覆盖 `kokoro-credit`，并把当前已有 owner/site active checker 半成品纳入收束范围；不展开 `payment`、`model`、`admin-web`。

## 1. 为什么第三个做 credit

`kokoro-site` 已经提供站点 active 边界，`kokoro-user` 已经提供 user/team owner active 边界。`kokoro-credit` 是下一层业务账本，所有 AI 产品里的用量计费、套餐到账、模型调用扣费都要经过它。

选择 credit 的理由：

- 它是 L3 变现闭环的核心余额与流水系统，错一次会直接影响用户资产。
- 现有 `credit` 已有幂等键、hold/capture/release、pricing quote，基础方向正确，但 owner/site active 半成品还没有整体收束。
- `payment` 的到账最终要写 credit ledger；credit 不稳时继续推进 payment 会把问题放大。
- AI 产品计量设计里，报价、冻结、结算、用量记录必须分层，否则很难解释一次模型调用为何扣了多少钱。

## 2. 范围

本轮只改：

- `kokoro-credit/prisma/schema.prisma`
- `kokoro-credit/src/domain/*`
- `kokoro-credit/src/application/credit-service.ts`
- `kokoro-credit/src/infrastructure/prisma/prisma-credit-repository.ts`
- `kokoro-credit/src/infrastructure/http/owner-site-checker.ts`
- `kokoro-credit/src/interfaces/http/*`
- `kokoro-credit/src/interfaces/admin/*`
- `kokoro-credit/test/unit/*`
- `kokoro-credit/test/integration/*`
- 必要时只小改 `kokoro-platform-kit` 已有导出能力；不抽新框架。

不在本轮做：

- 不改 `payment` 业务流程。
- 不改 `model` pricing 来源模型。
- 不做 admin-web 大改。
- 不允许业务硬删账本、用量、余额相关数据；测试夹具和本地 dev DB reset 可以清库。

## 3. 当前取证

DB 现状：

- `CreditAccount` 有 `siteId/ownerKind/ownerId/status/balanceMicros/heldMicros`，但没有删除审计列。
- `CreditLedgerEntry` 有 `amountMicros/balanceAfterMicros/reason/idempotencyKey/requestId`，是资金流水事实记录。
- `CreditHold` 是冻结状态机，有 `active/captured/released/expired`。
- `UsageRecord` 是用量事实记录，来自 capture 后的结算。
- `PricingRule` 是报价配置，有 `status/effectiveFrom/effectiveUntil`，但没有删除审计列。

代码现状：

- repository 已有并发幂等处理：ledger 和 hold 用 `idempotencyKey` 唯一约束。
- spend/hold 已使用 DB 条件更新，避免可用额并发超扣。
- service 已有 owner/site active checker 半成品，grant/spend/hold 前置查 account 后调用 checker。
- production main 已准备注入 `HttpOwnerSiteChecker`。
- admin manifest 仍是手写对象，后续容易出现 action 与 route 漂移。

## 4. 设计决策

### D1. 账务事实表 append-only

不对以下表提供业务 delete/restore：

- `CreditLedgerEntry`
- `UsageRecord`

理由：ledger 是余额变化证据，usage 是 AI 产品计量证据。它们必须能解释“谁、在什么站点、因为什么、扣/加了多少”。删除这些事实会破坏审计、退款、争议处理和对账。

### D2. `CreditHold` 只走状态机

`CreditHold` 不做 delete/restore，只允许：

- `active -> captured`
- `active -> released`
- `active -> expired`

理由：hold 是扣费前的冻结承诺，不是配置资源。即使释放，也要保留记录用于解释可用额变化和并发保护。

### D3. `CreditAccount` 可 delete/restore，但不清余额

`CreditAccount` 增加：

```prisma
deletedAt    DateTime?
deletedBy    String?
deleteReason String?
```

删除 account 的含义：

- 默认业务列表不可见。
- grant/spend/hold 拒绝。
- owner active checker 不再继续放行。
- 余额与历史流水保留。
- 未结算 active holds 必须先释放或过期，本轮先选择“有 active hold 时拒绝删除”。

理由：账户是 owner 的资产容器，删除应退出业务流通，但不能抹掉余额和流水。active hold 未处理时删除会让 heldMicros 长期悬空，所以先拒绝。

### D4. `PricingRule` 可 delete/restore

`PricingRule` 增加同样删除审计列。默认 quote 只查：

- `status=active`
- `deletedAt=null`
- `effectiveFrom <= now`
- `effectiveUntil is null or > now`

理由：pricing rule 是配置，不是账务事实。删除后不应参与新报价，但历史 quote/usage/ledger 仍由当时写入的 amount 和 usage 解释。

### D5. status 与 deletedAt 分离

- `status=disabled`：资源存在但暂不可用。
- `deletedAt != null`：资源退出默认业务流通，只能 admin 恢复。

理由：禁用是运营开关，删除是生命周期治理。二者不应互相覆盖，恢复删除不应自动启用 disabled 资源。

### D6. owner/site active checker fail-closed

生产环境 credit 改账前调用：

- `GET /sites/:siteId/active`
- `GET /owners/:ownerKind/:ownerId/active`

不可达或返回 inactive 时，grant/spend/hold 拒绝。

理由：credit 不跨库读 user/site，保持子仓边界清晰；但钱相关操作必须在外部 owner 被封、站点被停时立即停止。

### D7. Admin contract 单源

新增 `kokoro-credit/src/interfaces/admin/credit-admin-contract.ts`，`manifest.ts` 从 contract 导出。

Contract 包含：

- resources: credit-accounts / ledger-entries / usage-records / pricing-rules
- actions: grant, delete account, restore account, create pricing rule, delete pricing rule, restore pricing rule
- route/method/kind/requiredPermission

理由：credit admin 是运营入口，不能出现“manifest 声明了动作但后端没有 route”。这条要延续 site/user 的收束方式。

## 5. DB 设计

### 5.1 需要删除审计列的表

只给业务资源表加删除审计：

- `CreditAccount`
- `PricingRule`

不加删除审计：

- `CreditLedgerEntry`
- `UsageRecord`
- `CreditHold`

### 5.2 索引

建议新增：

```prisma
@@index([siteId, status, deletedAt])        // CreditAccount
@@index([deletedAt])                        // CreditAccount
@@index([featureKey, status, deletedAt])    // PricingRule
@@index([deletedAt])                        // PricingRule
```

保留：

- `CreditAccount(siteId, ownerKind, ownerId)` 唯一约束，删除后不复用 owner account，只能 restore。
- ledger/usage/hold 的 idempotency 唯一约束。

设计理由：

- account 列表和改账前查询都按 site/status/deleted 过滤。
- pricing quote 按 feature/status/deleted/effective 时间查找。
- 唯一 owner account 不复用，避免同一个 owner 的历史余额和新账户拆成两套资产。

### 5.3 本地 DB 策略

开发库可以 `db:reset`。业务代码不能 hard delete 账户、pricing rule、ledger、usage、hold。测试夹具可以清表。

## 6. 核心业务链路

### A. ensure account

输入：header siteId + body `ownerKind/ownerId`。

行为：

- owner/site 必须 active。
- `(siteId, ownerKind, ownerId)` 已删除时返回 `credit.account.deleted`，不自动恢复。
- 未删除时幂等返回同一账户。

理由：ensure 是创建入口，不能绕过 user/site 删除或停用，也不能靠 ensure 自动恢复被运营删除的账户。

### B. grant credits

输入：`accountId/amountMicros/idempotencyKey/reason/requestId`。

行为：

- amount 必须正数。
- account 必须 active 且未删除。
- site/owner 必须 active。
- 幂等键相同返回同一 ledger entry，不重复到账。

理由：grant 是加钱入口，既要防重复，也要防给已停站点或已删除 owner 继续发放资产。

### C. spend credits

输入同 grant。

行为：

- account active 且未删除。
- site/owner active。
- 条件更新保证 `balanceMicros - heldMicros >= amount`。
- 幂等键相同不重复扣费。

理由：held 金额是已经承诺给将来 capture 的资金，spend 不能侵占。

### D. hold / capture / release

hold：

- account active 且未删除。
- site/owner active。
- 条件更新保证可用额足够。

capture：

- hold 必须 active。
- actual amount 不超过 hold amount。
- 原子状态转移 active -> captured。
- 写 ledger 和 usage。
- 不重复 owner/site active 检查；hold 时已校验，capture 是完成同一次业务承诺。

release：

- hold active 可释放。
- released 再调用幂等返回。
- captured 不可释放。

理由：AI 模型调用常见“先预估冻结，再按实际 token 结算”。冻结与结算分离能支持流式调用、失败释放、实际用量小于预估。

### E. quote pricing

输入：`featureKey/labelKey/quantity`。

行为：

- 先找 label 精确规则，再回退 generic。
- 跳过 disabled、deleted、未生效、已过期规则。
- 返回 unit、unit amount、quantity、总 amount。

理由：报价是 AI 产品体验的一部分，前端/调用方要能在扣费前知道预估价格；历史扣费仍由 ledger/usage 固化。

### F. delete/restore account

建议 routes：

- `DELETE /credit/accounts/:accountId`
- `POST /credit/accounts/:accountId/restore`

删除前置：

- account 必须存在。
- account 没有 active holds。
- 删除后 grant/spend/hold 拒绝。
- ledger/usage/audit 仍可查。

### G. pricing rule create/delete/restore

建议 routes：

- `POST /credit/pricing-rules`
- `DELETE /credit/pricing-rules/:pricingRuleId`
- `POST /credit/pricing-rules/:pricingRuleId/restore`

理由：pricing rule 是配置资源，必须能由 admin 增删恢复；quote 默认只看未删除规则。

## 7. 目录与文件命名

TypeScript 文件：

- 生命周期类型：`kokoro-credit/src/domain/credit-lifecycle.ts`
- admin 单源契约：`kokoro-credit/src/interfaces/admin/credit-admin-contract.ts`
- repository 继续在 `kokoro-credit/src/infrastructure/prisma/prisma-credit-repository.ts`
- HTTP schema 先继续在 `kokoro-credit/src/interfaces/http/schemas.ts`
- 跨服务 checker 保持 `kokoro-credit/src/infrastructure/http/owner-site-checker.ts`

类型与方法：

- 类型名：`DeleteInput`、`RestoreInput`、`ListOptions`
- account 方法：`deleteAccount`、`restoreAccount`
- pricing 方法：`createPricingRule`、`deletePricingRule`、`restorePricingRule`
- 错误码：`credit.account.deleted`、`credit.account.active_hold_exists`、`credit.pricing_rule.deleted`

Python：

- 本轮不新增 Python。
- 若必须写一次性脚本，只放 `scripts/` 或 `tmp/`，文件名 lower_snake_case。

## 8. 风险

- `CreditAccount` 删除不能清余额，否则账务不可对。
- pricing rule 删除不能影响历史 usage/ledger。
- capture/release 的状态机不能因为 account deleted 而破坏已存在 hold 的结算解释。
- `db:generate` 必须执行，因为 credit 使用 package-local generated prisma client。
- 当前 worktree 有既有脏改动，提交必须 scoped 到 credit 本轮文件和计划文档。

## 9. 下一步交付物

1. credit 生命周期 TDD 执行计划。
2. repository 红灯测试。
3. Prisma schema + migration + generate/reset。
4. repository/service/http/admin contract 实现。
5. `kokoro-credit` typecheck/unit/integration/lint。
6. scoped commit。
