# kokoro-payment

套餐、订单、订阅、支付事件、退款和支付 provider 配置模块。

## 当前职责

`kokoro-payment` 是购买、订单、支付事件和订阅状态的权威模块。它不自研支付网关，不直接写 credit 账本。支付成功后通过 credit API 发放积分或权益。

## DDD 结构

```text
src/domain/                 领域类型、幂等策略、领域错误、repository interface
src/application/            支付用例
src/infrastructure/prisma/  Prisma repository 实现
src/interfaces/http/        HTTP API
src/interfaces/admin/       admin manifest
src/config/                 env 解析
src/module.ts               平台模块元数据
```

## 当前能力

```text
Plan
Order
Subscription
PaymentEvent
Refund
PaymentProvider config（webhook secret 只存 env 引用，不落明文）
order idempotency conflict
payment event idempotency conflict
webhook 验签（provider 抽象接口；V1 mock=HMAC-SHA256 over rawBody，header x-kokoro-webhook-signature）
webhook 重放防护（(provider,eventId) 唯一键，重复投递幂等 200 不重处理）
payment event 状态机 received→processed|failed（payment_succeeded 驱动订单幂等确认链）
failed 事件手动重放（admin replay 端点）
```

当前 HTTP 面：

```text
GET    /healthz
POST   /plans/upsert
DELETE /plans/:planId
POST   /plans/:planId/restore
POST   /orders
POST   /orders/sweep
POST   /orders/:id/confirm
POST   /orders/:id/refund
POST   /payment-events/record
POST   /payments/webhooks/:provider
GET    /admin/payments/{plans,orders,subscriptions,events,refunds,providers}
POST   /admin/payments/grant-plan
POST   /admin/payments/providers/upsert
DELETE /admin/payments/providers/:key
POST   /admin/payments/events/:id/replay
```

webhook 链路：

```text
POST /payments/webhooks/:provider
  → providers 表查配置（未配置/停用=404，kind 未实现验签=501）
  → secretRef 解析 env 密钥（悬空=500 fail-closed）
  → provider.verifySignature(headers, rawBody, secret)（坏签/缺头=401）
  → 事件幂等入库（重复投递 200 不重处理）
  → received→processed|failed；payment_succeeded → confirmOrder（幂等键 order:<id>）
  → failed 留 lastError，走 POST /admin/payments/events/:id/replay 手动重放
```

## 运行与部署

```bash
pnpm --filter @kokoro/payment dev
pnpm --filter @kokoro/payment start
```

关键 env：

```text
DATABASE_URL_PAYMENT
KOKORO_PAYMENT_PORT=4241
KOKORO_PAYMENT_BASE_URL=http://kokoro-payment:4241
```

容器和 Kubernetes 中通过 `kokoro-payment` 服务名访问，不在服务间调用里写 `localhost`。provider event、order idempotency 和 webhook 重放状态必须落 MySQL，不能依赖单进程状态。

## 下一步补齐

```text
plan:
  feature bundle metadata
  active/disabled
  price/currency/interval 管理

provider config:
  stripe/alipay/wechat 真实验签实现（kind 已建模，注册表缺位=501 占位）
  paddle/lemon_squeezy kind 扩展
  merchant/app id、certRef

order:
  create checkout/session
  providerOrderId
  canceled 状态流转

subscription:
  providerSubscriptionId
  currentPeriodStart/currentPeriodEnd
  active/canceled/past_due

refund:
  provider refund id
  失败重试

admin:
  订单查询过滤
  订阅状态
```

## 边界

- 不直接写 credit ledger。
- 不保存支付密钥明文。
- 不自己实现完整支付后台。
- 不决定用户权限。
