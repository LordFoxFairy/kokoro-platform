# kokoro-payment 单仓完善技术方案

> 状态：方案锁定稿。本文只覆盖 `kokoro-payment`，并把当前已有金额锚定、refund reverse-first、manifest 半成品纳入收束范围；不展开 `model`、`platform-admin`、`admin-web`。

## 1. 为什么第四个做 payment

`kokoro-site` 已经稳定站点生命周期，`kokoro-user` 已经稳定 user/team owner 生命周期，`kokoro-credit` 已经稳定余额、账本、报价和 owner/site guard。`kokoro-payment` 是变现链路里“卖什么、谁买、支付状态是什么”的权威模块，必须跟 credit 的账本边界对齐。

选择 payment 的理由：

- L3 变现闭环已经通过界面验证，但 payment 仍有 contract 漂移和套餐生命周期缺口。
- payment 是 credit 的上游，订单确认和退款都会触发 credit grant/spend；payment 不稳会直接污染余额。
- 当前已有正确方向的半成品：`createOrder` 已开始锚定 plan 金额，`refundOrder` 已采用 reverse-first saga，manifest 已开始补 upsert 动作。
- admin manifest 里还存在“声明但无端点”的动作，必须消掉假能力。

## 2. 范围

本轮只改：

- `kokoro-payment/prisma/schema.prisma`
- `kokoro-payment/src/domain/*`
- `kokoro-payment/src/application/payment-service.ts`
- `kokoro-payment/src/infrastructure/prisma/prisma-payment-repository.ts`
- `kokoro-payment/src/interfaces/http/*`
- `kokoro-payment/src/interfaces/admin/*`
- `kokoro-payment/test/unit/*`
- `kokoro-payment/test/integration/*`
- 必要的 payment migration。

不在本轮做：

- 不接 Stripe、支付宝、微信等真实 provider。
- 不新增订阅续费引擎。
- 不新增 invoice、coupon、tax、receipt。
- 不改 credit schema；payment 继续通过 credit HTTP/service contract 发放或扣回积分。
- 不允许业务硬删订单、支付事件、退款、订阅；测试夹具和本地 dev DB reset 可以清库。

## 3. 当前取证

DB 现状：

- `Plan` 有 `siteId/key/name/currency/amountMinor/creditMicros/billingInterval/status`，没有删除审计列。
- `Order` 有 `siteId/teamId/planId/amountMinor/currency/status/idempotencyKey/provider/providerOrderId`，是购买事实和支付状态记录。
- `Subscription` 已建表但业务逻辑很浅，是订阅事实/状态记录。
- `PaymentEvent` 以 `(provider,eventId)` 幂等记录 provider 事件。
- `Refund` 记录退款事实，当前由 `refundOrder` 创建。

代码现状：

- `createOrder` 已校验 plan 存在、plan 属本站、订单金额和币种必须匹配 plan。
- `confirmOrder` 对 pending order 先调用 credit grant，再标记 paid；失败时 order 保持 pending，可重试。
- `refundOrder` 对 paid order 先调用 credit spend 扣回积分，再同库原子标 refunded 和创建 Refund；失败时 order 保持 paid，可重试。
- repository 对 order/payment event 已有幂等冲突检测。
- admin manifest 仍是手写对象，`plans.publish`、`refunds.approve` 是无端点假动作。

## 4. 设计决策

### D1. 支付事实表不做业务删除

不对以下表提供业务 delete/restore：

- `Order`
- `PaymentEvent`
- `Refund`
- `Subscription`

理由：这些都是支付、provider、退款和订阅状态事实。订单是否 paid/refunded、provider 发过什么 event、退款是否成功，必须能用于对账、客服、争议处理和审计。删除这些事实会破坏“为什么到账、为什么扣回”的解释链。

### D2. `Plan` 可 delete/restore，但不复用 `(siteId,key)`

只给 `Plan` 增加：

```prisma
deletedAt    DateTime?
deletedBy    String?
deleteReason String?
```

删除 plan 的含义：

- 默认业务列表不可见。
- `createOrder` 拒绝基于 deleted plan 下单。
- `grantPlanToTeam` 拒绝基于 deleted plan 授套餐。
- 历史 order/subscription/refund/event 仍可查，仍指向原 plan。
- 恢复后 plan 重新可下单/授予。

保留 `@@unique([siteId,key])`，删除后不允许同 site 复用 key，只能 restore。

理由：plan 是可运营配置，不是支付事实；它可以退出默认销售流通。但 key 复用会让历史订单“看起来买了同名新套餐”，破坏对账和客服解释。

### D3. status 与 deletedAt 分离

- `status=disabled`：计划存在但暂不可售。
- `deletedAt != null`：计划退出默认业务流通，只能 admin 恢复。

恢复删除不会自动改变 disabled 状态。

理由：禁用是运营开关，删除是生命周期治理。二者不能互相覆盖。

### D4. 下单必须锚定 plan 定价

`createOrder` 必须同时满足：

- plan 存在。
- plan 属于请求 siteId。
- plan 未删除。
- plan status 为 active。
- request `amountMinor/currency` 等于 plan 当前值。

理由：payment 是“卖什么”的权威。客户端不能传 1 元买 49 元套餐，再由 confirm 按 plan 发足额 credit。

### D5. confirm/refund 与 credit 的顺序保持不变

confirm：

1. order 必须 pending。
2. plan 存在且未删除。
3. 如果 `creditMicros > 0`，先调用 credit grant，幂等键 `order:<orderId>`。
4. grant 成功后标记 order paid。

refund：

1. order 必须 paid。
2. plan 存在。
3. 如果 `creditMicros > 0`，先调用 credit spend，幂等键 `order-refund:<orderId>`。
4. spend 成功后同库原子标记 order refunded 并创建 Refund。

理由：跨库没有分布式事务。先 credit 后 payment 的顺序让失败态保持可重试：confirm grant 失败则 order 仍 pending；refund reverse 失败则 order 仍 paid。

### D6. `PaymentEvent` 继续不加 siteId

`PaymentEvent` 继续以 `(provider,eventId)` 幂等，不在本轮加 siteId。

理由：provider event id 是外部事实去重键。当前没有真实 provider webhook 映射，不应提前改动 event 幂等模型。后续接真实 provider 时再用 payload 映射 order/site。

### D7. Admin contract 单源，并清掉假动作

新增 `kokoro-payment/src/interfaces/admin/payment-admin-contract.ts`，`manifest.ts` 从 contract 导出。

保留真实动作：

- plans: `upsert`, `delete`, `restore`, `grant-to-team`
- orders: `refund`

删除假动作：

- `plans.publish`
- `refunds.approve`

理由：manifest 是运营台和 gateway 的能力契约。声明动作但没有 route，会让前端出现“点了必失败”的假能力。

## 5. DB 设计

### 5.1 需要删除审计列的表

只给配置资源表加删除审计：

- `Plan`

不加删除审计：

- `Order`
- `Subscription`
- `PaymentEvent`
- `Refund`

### 5.2 索引

新增：

```prisma
@@index([siteId, status, deletedAt])
@@index([deletedAt])
```

保留：

- `Plan(siteId,key)` 唯一约束。
- `Order.idempotencyKey` 唯一约束。
- `PaymentEvent(provider,eventId)` 唯一约束。

设计理由：

- admin 和业务 plan 列表主要按 site/status/deleted 过滤。
- quote/order/grant-plan 前置读取 plan，需要明确 deleted-aware。
- order/event 的幂等约束是支付事实防重复的核心，不随 plan 生命周期变化。

## 6. 核心业务链路

### A. upsert plan

输入：header siteId + body `key/name/currency/amountMinor/creditMicros/billingInterval`。

行为：

- amountMinor 必须正整数。
- creditMicros 必须非负整数。
- `(siteId,key)` 已删除时返回 `payment.plan.deleted`，不自动恢复。
- 未删除时更新 plan 并保持 active。

理由：upsert 是配置写入口，不能绕过运营删除状态。

### B. create order

输入：header siteId + body `teamId/planId/amountMinor/currency/idempotencyKey`。

行为：

- plan 必须属于同 site。
- plan 必须 active 且未删除。
- amount/currency 必须等于 plan。
- idempotencyKey 相同且请求目标一致时返回同一 order。

理由：订单是购买事实，必须锚定当时 plan 定价，不让客户端决定权益价值。

### C. confirm order

输入：`orderId` + requestId。

行为：

- order missing -> 404。
- paid -> 幂等返回。
- 非 pending -> 409。
- plan missing/deleted -> 404/409；order 保持 pending。
- credit grant 失败 -> 抛错；order 保持 pending。
- grant 成功后标 paid。

理由：支付确认是到账入口，必须保证 paid 表示 credit grant 已成功或无需 grant。

### D. refund order

输入：`orderId` + requestId。

行为：

- refunded -> 返回既有 Refund，不重复 reverse。
- 非 paid -> 409。
- credit reverse 失败 -> 抛错；order 保持 paid。
- reverse 成功后同库事务 paid -> refunded + Refund row。

理由：退款是扣回权益入口，必须保证 refunded 表示 credit reverse 已成功或无需 reverse。

### E. delete/restore plan

建议 routes：

- `DELETE /plans/:planId`
- `POST /plans/:planId/restore`
- `DELETE /admin/payments/plans/:planId`
- `POST /admin/payments/plans/:planId/restore`

删除前置：

- plan 必须存在。
- 删除后不能 createOrder/grantPlanToTeam。
- 历史 order/subscription/refund/event 不受影响。

## 7. 目录与文件命名

TypeScript 文件：

- 生命周期类型：`kokoro-payment/src/domain/payment-lifecycle.ts`
- admin 单源契约：`kokoro-payment/src/interfaces/admin/payment-admin-contract.ts`
- repository 继续在 `kokoro-payment/src/infrastructure/prisma/prisma-payment-repository.ts`
- HTTP schema 继续在 `kokoro-payment/src/interfaces/http/schemas.ts`
- credit 客户端继续在 `kokoro-payment/src/infrastructure/credit-grant-client.ts`

类型与方法：

- 类型名：`DeletionAudit`、`DeleteInput`、`RestoreInput`、`ListOptions`
- plan 方法：`deletePlan`、`restorePlan`
- 错误码：`payment.plan.deleted`、`payment.plan.not_found`

Python：

- 本轮不新增 Python。
- 若必须写一次性脚本，只放 `scripts/` 或 `tmp/`，文件名 lower_snake_case。

## 8. 风险

- Plan 删除不能影响历史订单解释。
- Order/Refund/PaymentEvent 不能业务删除，否则会破坏对账。
- `db:generate` 必须执行，因为 payment 使用 package-local generated Prisma client。
- 当前 worktree 有既有脏改动，提交必须 scoped 到 payment 本轮文件和本文档/计划。
- `plans.publish` 和 `refunds.approve` 若暂不实现，必须从 manifest 删除，而不是留空 route。

## 9. 下一步交付物

1. payment 生命周期 TDD 实施计划。
2. repository 红灯测试。
3. Prisma schema + migration + generate/reset。
4. repository/service/http/admin contract 实现。
5. `kokoro-payment` typecheck/unit/integration/lint。
6. scoped commit。
