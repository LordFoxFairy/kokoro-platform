# kokoro-credit

积分账户、扣费、用量、冻结、账本和计价规则模块。

## 当前职责

`kokoro-credit` 是实时积分和账本权威。agent、model、tool、payment 都不能直接改余额，必须通过 credit 的应用服务/API。

## DDD 结构

```text
src/domain/                 领域类型、领域策略、领域错误、repository interface
src/application/            积分用例
src/infrastructure/prisma/  Prisma repository 实现
src/interfaces/http/        HTTP API
src/interfaces/admin/       admin manifest
src/config/                 env 解析
src/module.ts               平台模块元数据
```

## 当前能力

```text
CreditAccount
CreditLedgerEntry
CreditHold
UsageRecord
PricingRule
余额不足领域策略
grant/spend API
idempotencyKey
```

当前 HTTP 面：

```text
GET  /healthz
POST /credit/accounts/ensure
POST /credit/grant
POST /credit/spend
POST /credit/hold            冻结指定金额（raw micros）
POST /credit/capture         结算冻结（raw micros）
POST /credit/release         释放冻结
POST /credit/quote           按 pricing 报价
POST /credit/usage/hold      run 受理冻结（按 pricing 预估用量算冻结额）
POST /credit/usage/settle    run 终态结算（按 token 用量复算实额，clamp 到冻结额）
POST /credit/pricing-rules   创建计价规则
```

用量计费面（run 计费链，调用方只报用量，金额计算全在 credit）：

```text
POST /credit/usage/hold
  入参 {namespace, featureKey, labelKey?, idempotencyKey, modelBindingId?, requestId?}
       siteId 从 x-kokoro-site-id header；namespace(=teamId) → (siteId, team, namespace) 账户
  行为 按 pricing × 配置化预估用量 × (1 + buffer%) 算冻结额，落 pricing_ref 到 hold
  出参 {holdId, accountId, amountMicros}；余额不足 → 402 credit.insufficient

POST /credit/usage/settle
  入参 {holdId, usage:{inputTokens, outputTokens}, idempotencyKey}
  行为 按 hold 上的 pricing_ref 与真实 token 复算实额，clamp 到冻结额（先守不透支），capture 入账
       实额为 0 → 释放冻结不入账；idempotencyKey=run_id，重放同结果
  出参 {holdId, outcome: captured|released, amountMicros, account}

失败/取消复用 POST /credit/release。
```

## 运行与部署

```bash
pnpm --filter @kokoro/credit dev
pnpm --filter @kokoro/credit start
```

关键 env：

```text
DATABASE_URL_CREDIT
KOKORO_CREDIT_PORT=4231
KOKORO_CREDIT_BASE_URL=http://kokoro-credit:4231
```

容器和 Kubernetes 中通过 `kokoro-credit` 服务名访问，不在服务间调用里写 `localhost`。余额、账本、冻结、幂等状态必须全部落 MySQL，不能依赖单进程状态。

## 下一步补齐

```text
账户:
  余额查询
  禁用账户

用量:
  UsageRecord failed（失败 run 的用量落账）

权益:
  Entitlement
  SpendLimit
  plan 周期额度

admin:
  账户余额
  账本流水
  用量记录
  pricing rule
  人工调整
```

## 边界

- 不管理套餐商品。
- 不对接支付 provider。
- 不决定模型 fallback。
- 不直接读取 agent 内部状态。
