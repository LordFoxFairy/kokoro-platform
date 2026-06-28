# kokoro-credit 技术方案

## 定位

`kokoro-credit` 是积分账户、冻结、账本、usage、pricing rule、权益和扣费闭环的权威模块。

## 职责

拥有：

- CreditAccount
- CreditHold
- CreditLedgerEntry
- UsageRecord
- PricingRule
- Entitlement
- SpendLimit

不拥有：

- 支付订单 capture
- 模型 provider 路由
- 用户身份
- agent 任务执行

## 当前模型

已实现：

```text
credit_accounts
credit_ledger_entries
credit_holds
credit_usage_records
credit_pricing_rules
```

当前接口：

```text
GET  /healthz
POST /credit/accounts/ensure
POST /credit/grant
POST /credit/spend
```

## 站点化改造

关键表需要增加 `siteId`：

```text
CreditAccount.siteId
CreditLedgerEntry.siteId
CreditHold.siteId
UsageRecord.siteId
PricingRule.siteId
```

唯一约束调整：

```text
CreditAccount unique(siteId, ownerKind, ownerId)
LedgerEntry unique(siteId, idempotencyKey)
CreditHold unique(siteId, idempotencyKey)
UsageRecord unique(siteId, idempotencyKey)
PricingRule index(siteId, featureKey, status)
```

## 扣费模型

实时扣费不能放 agent 里直接改余额。正确流程：

```text
1. agent/session 请求 quote
2. credit 根据 siteId + featureKey + modelBindingId + plan 计算预估
3. credit 创建 hold
4. agent 执行任务
5. 成功后 commit hold，写 ledger 和 usage
6. 失败或取消 release hold
7. 实际消耗和预估不同，补差或退款
```

这样支持：

- 多 Pod
- 重试
- 幂等
- 失败退款
- 超时释放
- 审计

## 套餐和积分包

需要支持：

```text
subscription allowance
  套餐周期内赠送额度。

top-up package
  增量积分包，和套餐分开管理。

discount / multiplier
  不同 plan 对不同 capability 使用折扣。

feature entitlement
  有些能力不是扣分，而是是否可用。
```

Studio 和 General 默认可以使用不同 featureKey：

```text
general.music.generate
studio.music.generate
studio.video.generate
```

这样同一个 provider 成本可以映射到不同产品价格。

## Admin

admin manifest 管理：

```text
accounts
ledger
usage
pricing rules
```

后续增加：

```text
holds
entitlements
spend limits
manual adjustments
```

## 部署

服务名：

```text
kokoro-credit
```

端口：

```text
4231
```

环境变量：

```text
DATABASE_URL_CREDIT
KOKORO_CREDIT_PORT
KOKORO_CREDIT_BASE_URL
KOKORO_SITE_BASE_URL
KOKORO_MODEL_BASE_URL
```

## 测试

必须补：

- 同 idempotencyKey 重试不重复扣。
- 余额不足不能创建 hold。
- commit hold 后余额正确。
- release hold 后 heldMicros 归零。
- 不同 site 同 ownerId 账户隔离。
- payment 成功只通过 credit grant 发放。

## 风险

不要允许 payment、agent、model 直接写 credit 表。所有余额变化必须通过 credit service。
