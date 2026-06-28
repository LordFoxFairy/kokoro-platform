# kokoro-payment 技术方案

## 定位

`kokoro-payment` 是 plan、order、subscription、payment event、refund 和支付 provider webhook 的权威模块。

## 职责

拥有：

- Plan / PlanTemplate
- SiteOffer
- Order
- Subscription
- PaymentEvent
- Refund
- ProviderPaymentConfig

不拥有：

- 积分账本
- 运行时 usage metering
- 模型 provider routing
- 用户身份

## 当前模型

已实现：

```text
payment_plans
payment_orders
payment_subscriptions
payment_events
payment_refunds
```

当前接口：

```text
GET  /healthz
POST /plans/upsert
POST /orders
POST /payment-events/record
```

## 站点化改造

需要增加：

```text
PlanTemplate
SiteOffer
ProviderPaymentConfig
```

关键字段：

```text
Plan:
  siteId, key, name, currency, amountMinor, billingInterval, status

Order:
  siteId, teamId/workspaceId, planId/offerId, amountMinor, currency,
  status, idempotencyKey, provider, providerOrderId

Subscription:
  siteId, teamId/workspaceId, planId/offerId, status, providerSubscriptionId

PaymentEvent:
  siteId?, provider, eventId, eventType, payload, status
```

唯一约束：

```text
Plan unique(siteId, key)
Order unique(siteId, idempotencyKey)
PaymentEvent unique(provider, eventId)
Subscription index(siteId, teamId, status)
```

## Provider 策略

支付底层不从 0 实现。

优先接成熟 provider：

```text
Stripe
支付宝
微信支付
Paddle/LemonSqueezy，后续可选
```

`kokoro-payment` 保存的是：

- provider config 引用
- order 映射
- webhook 事件
- 状态机
- 对 credit 的发放请求

不复制 provider 的完整后台。

## 与 credit 的关系

支付成功后：

```text
payment event processed
  -> payment 确认 order/subscription
  -> 调用 credit grant/entitlement issue
  -> credit 写 ledger
```

payment 不能直接写 credit ledger。

## Admin

admin manifest 管理：

```text
plans
orders
subscriptions
payment events
refunds
```

后续增加：

```text
site offers
provider configs
webhook replay
manual reconciliation
```

## 部署

服务名：

```text
kokoro-payment
```

端口：

```text
4241
```

环境变量：

```text
DATABASE_URL_PAYMENT
KOKORO_PAYMENT_PORT
KOKORO_PAYMENT_BASE_URL
KOKORO_SITE_BASE_URL
KOKORO_CREDIT_BASE_URL
```

## 测试

必须补：

- provider event id 幂等。
- order idempotencyKey 幂等。
- 支付成功只触发一次 credit grant。
- 不同 site 可以有同 plan key。
- refund 不直接扣余额，必须形成明确 credit adjustment 流程。

## 风险

最大风险是把 plan、offer、credit package 混成一张表。正确做法是 payment 负责“卖什么”，credit 负责“到账什么权益和怎么消费”。
