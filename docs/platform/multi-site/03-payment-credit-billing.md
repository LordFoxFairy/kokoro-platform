# 03 payment + credit 站点计费设计

本文定义套餐、订单、积分、权益、定价和扣费如何在多站点下工作。

## 核心判断

```text
payment 负责卖什么和交易状态。
credit 负责余额、权益、计价、冻结、扣费、账本。
site 决定哪个站点卖哪些 offer、开什么能力、按什么策略运行。
```

不要把套餐、积分、权益、价格混成一张表。

## payment 模型

### PlanTemplate

平台可复用的套餐模板，不直接售卖。

```text
PlanTemplate
  id
  key
  name
  defaultBenefitJson
  status
```

例子：

```text
creator_basic
music_pro
video_pro
studio_max
```

### SiteOffer

站点实际售卖的商品。

```text
SiteOffer
  id
  siteId
  planTemplateId
  offerKey
  name
  currency
  amountMinor
  billingInterval = once | month | year
  trialPolicy
  discountPolicy
  status
```

同一个模板可在多个站点不同价格售卖：

```text
site_music + music_pro = 19 USD/month
site_video + music_pro = 不售卖
site_zeze  + creator_basic = 9 USD/month
```

### Order

```text
Order
  siteId
  userId
  workspaceId
  offerId
  amountMinor
  currency
  status = pending | paid | canceled | refunded
  provider
  providerOrderId
  idempotencyKey
```

### Subscription

```text
Subscription
  siteId
  workspaceId
  offerId
  status = active | canceled | past_due
  provider
  providerSubscriptionId
  currentPeriodStart
  currentPeriodEnd
```

### PaymentEvent

```text
PaymentEvent
  siteId
  provider
  eventId
  eventType
  payload
  status = received | processed | failed
```

支付事件幂等：

```text
unique(siteId, provider, eventId)
```

## credit 模型

### CreditAccount

```text
CreditAccount
  siteId
  ownerKind = user | workspace
  ownerId
  status
```

默认 workspace 维度更适合团队协作，个人用户使用 personal workspace。

### CreditBucket

积分包/额度来源。

```text
CreditBucket
  siteId
  accountId
  source = free_trial | free_monthly | subscription | topup | admin_grant | refund
  originalMicros
  remainingMicros
  expiresAt
  priority
  restrictionPolicy
  sourceRefType
  sourceRefId
```

为什么需要 bucket：

```text
免费额度会过期。
订阅额度按周期刷新。
充值包可能不希望过期。
活动赠送可能只允许某能力使用。
退款需要追踪来源。
```

### EntitlementGrant

能不能用某能力。

```text
EntitlementGrant
  siteId
  workspaceId
  sourceKind = offer | admin | promotion
  sourceId
  capabilityKey
  surface
  limitPolicy
  validFrom
  validUntil
```

权益不是余额。用户有余额，也可能没有使用 studio 高级能力的权益。

### PricingRule

某能力扣多少。

```text
PricingRule
  siteId
  appKey
  surface
  capabilityKey
  modelLabel
  unit = token | generation | second | image | job | tool_call
  amountMicros
  discountPolicy
  priority
  effectiveFrom
  effectiveUntil
```

匹配顺序：

```text
1. siteId + appKey + surface + capabilityKey + modelLabel
2. siteId + appKey + surface + capabilityKey
3. siteId + capabilityKey
4. platform fallback
```

### CreditHold

长任务必须先冻结。

```text
CreditHold
  siteId
  accountId
  amountMicros
  status = active | captured | released | expired
  idempotencyKey
  expiresAt
```

### UsageRecord

```text
UsageRecord
  siteId
  accountId
  workspaceId
  userId
  capabilityKey
  modelBindingId
  quantity
  unit
  amountMicros
  status = quoted | held | settled | failed
  requestId
  jobId
  idempotencyKey
```

## 扣费闭环

```text
quote:
  检查 entitlement，匹配 pricing，返回预计积分。

hold:
  按预计积分冻结 bucket，避免长任务成功后余额不足。

capture:
  根据实际用量结算，扣 bucket，写 ledger，关闭 hold。

release:
  任务失败/取消时释放 hold。

refund:
  退款或补偿时写反向 ledger 或新 refund bucket。
```

## 扣 bucket 顺序

默认：

```text
1. 当前 site 即将过期 free_trial/free_monthly
2. 当前 site subscription bucket
3. 当前 site topup bucket
4. 当前 site admin_grant/refund bucket
```

默认不跨站扣。跨站积分包必须是单独产品：

```text
GlobalCreditBundle
CrossSiteCreditPass
```

即使以后支持，也要显式记录：

```text
消费 siteId
资金来源 scope
ledger entry
```

## 免费套餐

免费套餐不是简单给余额。

免费套餐应生成：

```text
EntitlementGrant:
  允许使用低成本能力。

CreditBucket:
  free_monthly 或 free_trial。

SpendLimit:
  每日/每月次数、单任务上限。
```

## 增量积分包

增量包只增加 bucket，不改变 entitlement。

例子：

```text
用户买了 1000 积分包。
如果当前 plan 不允许 video studio，高级 video studio 仍不能用。
```

这能避免“买了积分就越过套餐限制”。

## 折扣

折扣不是余额变化，应该在 pricing 阶段计算。

```text
SiteOffer -> EntitlementGrant -> PricingRule.discountPolicy
```

折扣可来源：

```text
订阅套餐
促销活动
白标客户协议
后台人工配置
```

## 与业务模块关系

业务模块只做：

```text
quote -> hold -> execute -> capture/release
```

业务模块不做：

```text
不直接扣余额。
不直接改 bucket。
不自己解释套餐。
不决定折扣。
```

## 风险

- 只保存 balance 会导致免费额度、订阅额度、充值包、退款混在一起。
- payment 直接发积分会绕过权益和审计。
- agent 直接扣费会导致不同能力各算各的。
- 跨站积分默认共享会破坏站点独立商业模型。

## 验收标准

- music 订阅不影响 video。
- music topup 不能默认在 video 消费。
- 免费额度过期后不可扣。
- 长任务失败会 release hold。
- 同 idempotencyKey 重试不会重复扣。
- ledger 能追溯 siteId、workspaceId、capabilityKey、jobId。
