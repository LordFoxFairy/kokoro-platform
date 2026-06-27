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
  heldMicros 冻结额度

扣费:
  quote
  hold
  capture
  release
  spend idempotency conflict 检测

计价:
  PricingRule 按 featureKey + labelKey + unit
  effectiveFrom/effectiveUntil

用量:
  UsageRecord settle/failed
  requestId 贯穿
  modelBindingId 关联

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
