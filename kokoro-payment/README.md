# kokoro-payment

套餐、订单、订阅、支付事件、退款和支付 provider 配置模块。

## 当前职责

`kokoro-payment` 是购买、订单、支付事件和订阅状态的权威模块。它不自研支付网关，不直接写 credit 账本。支付成功后通过 credit API 发放积分或权益。

## DDD 结构

```text
src/domain/                 领域类型、幂等策略、领域错误、repository contract
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
order idempotency conflict
payment event idempotency conflict
```

当前 HTTP 面：

```text
GET  /healthz
POST /plans/upsert
POST /orders
POST /payment-events/record
```

## 下一步补齐

```text
plan:
  feature bundle metadata
  active/disabled
  price/currency/interval 管理

provider config:
  stripe/alipay/wechat/paddle/lemon_squeezy
  merchant/app id
  secretRef/certRef
  webhook endpoint mapping

order:
  create checkout/session
  providerOrderId
  paid/canceled/refunded 状态流转

subscription:
  providerSubscriptionId
  currentPeriodStart/currentPeriodEnd
  active/canceled/past_due

payment event:
  webhook 验签后记录
  received/processed/failed
  可重放

refund:
  provider refund id
  succeeded/failed
  credit refund/revoke 联动

admin:
  plan 管理
  订单查询
  订阅状态
  支付事件重放
  provider 配置状态
```

## 边界

- 不直接写 credit ledger。
- 不保存支付密钥明文。
- 不自己实现完整支付后台。
- 不决定用户权限。
