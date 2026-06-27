# Kokoro Platform 子仓能力规划

本文用于约束 `kokoro-platform` 下各子仓的职责、后续补齐顺序和跨模块关系。目标不是把所有业务一次写完，而是避免后续 music studio、video、image、agent、skill hub、mcp hub、支付、积分、模型管理接入时边界混乱。

## 总原则

平台采用“业务自治，入口统一”的形态：

```text
kokoro-web / kokoro-admin
  统一登录、导航、i18n、主题、权限、后台壳子和模块页面渲染

kokoro-platform
  平台模块注册、统一验证、本地基础设施、边界约束

kokoro-user / model / credit / payment
  各自拥有 domain、application、infrastructure、interfaces
  各自拥有 Prisma schema、migration、HTTP/internal API、admin manifest

第三方系统
  LiteLLM、Stripe、支付宝、微信支付、Strapi 等成熟能力优先接入，不复制实现
```

每个业务子仓固定四层 DDD：

```text
src/domain          实体、值对象、领域错误、领域策略、repository interface
src/application     用例编排，不直接关心 HTTP/Prisma/第三方 SDK
src/infrastructure  Prisma、provider adapter、外部 SDK、队列实现
src/interfaces      HTTP、admin manifest、未来 RPC/worker/consumer adapter
src/config          环境变量解析
```

依赖方向：

```text
interfaces -> application -> domain
infrastructure -> domain/application
domain -> 不依赖外层
```

## 数据库策略

早期使用一个 MySQL database：`kokoro`。

原因：

- 本地开发简单。
- 管理平台查询和联动简单。
- 业务量还没到必须拆库。
- 子仓边界可以先靠目录、Prisma schema、表名前缀、API 和测试约束。

约束：

- 每个子仓自己维护 Prisma schema 和 migration。
- 表名要按领域隔离，避免 `orders`、`plans`、`provider_accounts` 这种泛名。
- 共享库只跑 `pnpm db:migrate`。
- 不在 root 对共享库跑 `pnpm -r db:dev`，Prisma 会把其它子仓表识别为 drift。
- 需要生成新 migration 时，用该子仓自己的临时 scratch database 生成，再部署到共享库。

后续如果业务变大，可以拆成多库。拆库是部署拓扑变化，不应改变 DDD 边界。

## 部署策略

每个业务子仓都必须能作为独立进程运行，也必须能在 Kubernetes 中多副本运行。

统一运行面：

```text
kokoro-user      KOKORO_USER_PORT=4211
kokoro-model     KOKORO_MODEL_PORT=4221
kokoro-credit    KOKORO_CREDIT_PORT=4231
kokoro-payment   KOKORO_PAYMENT_PORT=4241
```

统一内部服务地址：

```text
KOKORO_USER_BASE_URL=http://kokoro-user:4211
KOKORO_MODEL_BASE_URL=http://kokoro-model:4221
KOKORO_CREDIT_BASE_URL=http://kokoro-credit:4231
KOKORO_PAYMENT_BASE_URL=http://kokoro-payment:4241
```

部署红线：

- 子仓代码不写死 `localhost` 做服务间调用。
- 子仓不依赖进程内缓存保存关键业务状态。
- 子仓必须有 `/healthz`。
- 子仓必须在关闭 HTTP server 时释放数据库连接。
- credit/payment 这种涉及钱和积分的模块，所有关键写入都必须依赖数据库唯一索引、事务和幂等 key。

详细部署拓扑见 `docs/platform/deployment-topology.md`。

## 管理后台策略

不要让每个子仓各自写一套完整 Web 后台。

正确形态：

```text
子仓:
  提供 admin manifest
  提供管理 API
  提供权限 key
  提供资源/操作声明

kokoro-web / admin:
  统一渲染导航、列表、表单、详情页、审计页
  根据 manifest 和权限决定展示
  对复杂模块允许自定义页面 adapter
```

第三方后台策略：

- 已经有成熟后台的第三方，优先 OAuth/SSO、iframe、外链、admin link。
- 只有 Kokoro 自己需要治理的配置、映射、审计、状态才落入 Kokoro。
- 不复制 LiteLLM/Strapi/支付平台的完整后台。

Strapi 的官方插件和 Admin Panel API 允许插件向后台注册导航、设置页、注入组件和翻译。这个方向说明“可嵌入/扩展成熟后台”是可行的，但 Kokoro 仍应优先只保存自己的映射和跳转入口。

参考：

- https://docs.strapi.io/cms/plugins-development/admin-panel-api
- https://docs.strapi.io/cms/admin-panel-customization

## kokoro-user

定位：身份、团队、成员关系、角色、服务账号和审计的权威模块。

已具备：

- User、Team、Membership、Role、Invite、ServiceAccount、UserAuditLog。
- `POST /users/ensure`。
- `GET /me/teams`。
- admin manifest。
- MySQL + Prisma + integration tests。

后续必须补齐：

```text
用户:
  禁用/启用用户
  更新 profile
  lastSeenAt 更新
  external identity 映射策略

团队:
  创建 team workspace
  修改 team name/slug
  禁用/恢复团队
  personal team 不可重复创建约束

成员:
  邀请成员
  接受/撤销邀请
  修改成员角色
  移除成员

权限:
  role -> permissions 的校验器
  platform permission key registry
  admin action requiredPermission 校验

服务账号:
  创建 token
  rotate token
  revoke token
  token prefix + secret hash 校验

审计:
  用户/团队/成员/服务账号变更全部写审计
  requestId 贯穿 HTTP/API
```

不做：

- 不直接管理积分余额。
- 不直接管理支付订单。
- 不直接管理模型 provider secret。
- 不承担 agent session 业务状态。

跨模块关系：

```text
credit:
  ownerKind/team ownerId 来自 user/team

payment:
  order.teamId 必须指向有效 team

model:
  provider account 操作需要 user 权限校验

admin:
  所有后台 permission 基于 user/team/role 判定
```

## kokoro-model

定位：模型配置、provider account、model binding、model label、功能可见模型列表的权威模块。

已具备：

- ProviderAccount。
- ModelBinding。
- ModelLabel。
- `transportKind = litellm | direct | internal`。
- `gatewayModelName` 支持接 LiteLLM model_name。
- provider account priority、status、healthStatus。
- model binding featureKey、labelKeys、priority。
- admin manifest。

关键判断：

- LiteLLM 是 LLM 网关，不是 Kokoro 的模型业务权威。
- Kokoro-model 负责“哪些功能可以用哪些模型、优先级、账号、标签、展示、是否启用”。
- LiteLLM 负责代理、路由、虚拟 key、provider 请求和部分 spend tracking。
- 音乐、视频、图片等非 LLM provider 可以走 `direct` 或专门 adapter，不强行塞进 LiteLLM。

LiteLLM 官方文档显示它支持 virtual keys、模型访问控制、spend tracking、model aliases、budget/rate limit 等能力，因此 Kokoro 应利用它作为网关能力，而不是复制网关实现。

参考：

- https://docs.litellm.ai/docs/proxy/virtual_keys

后续必须补齐：

```text
provider account:
  主账号/兜底账号
  启用/停用
  priority 顺序
  secretRef，不保存明文 secret
  health check 结果写入 healthStatus

model binding:
  featureKey: general-chat, music, video, image, code 等
  labelKeys: fast, quality, cheap, pro, studio 等
  input/output modalities
  priority + fallback policy
  同 providerAccountId + modelName + transportKind 唯一

model label:
  给前端和业务套餐用的稳定 label
  不直接暴露 provider 内部命名
  支持 defaultBindingId

runtime query:
  list available models by featureKey + team plan + user permission
  resolve binding by requested label/provider/model
  fallback selection

admin:
  provider account 管理
  binding 管理
  label 管理
  health 状态展示
  secretRef 只显示引用，不显示 secret
```

不做：

- 不扣积分。
- 不写 LiteLLM 源码。
- 不直接决定用户是否有余额。
- 不保存大体积 provider raw output。

跨模块关系：

```text
credit:
  需要 pricing label 和 usage 上报，但余额权威在 credit

agent/session:
  通过 model 查询可用模型和 fallback，不直接读表

payment:
  plan 可决定哪些 model label 可用，但 model 不管理 plan
```

## kokoro-credit

定位：积分账户、扣费、用量、冻结、账本、计价规则的权威模块。

已具备：

- CreditAccount。
- CreditLedgerEntry。
- CreditHold。
- UsageRecord。
- PricingRule。
- 余额不足领域策略。
- grant/spend API。
- 幂等 key。
- admin manifest。

核心原则：

- 实时扣费权威在 credit。
- agent/model/tool 不直接改余额。
- 所有余额变化必须有 ledger entry。
- 用量记录和扣费可以先同步，后续再拆为事件/队列。

后续必须补齐：

```text
账户:
  ownerKind=user/team
  禁用账户
  账户余额查询
  heldMicros 冻结额度

扣费:
  quote -> hold -> capture/release
  spendCredits 保持原子扣减
  idempotency conflict 检测
  retry 安全

计价:
  PricingRule 按 featureKey + labelKey + unit
  model_call/tool_call/music_generation/video_generation
  effectiveFrom/effectiveUntil

用量:
  UsageRecord 记录 featureKey、amount、modelBindingId、requestId
  failed/settled 状态
  方便对账和重放

权益:
  Entitlement 后续加入
  SpendLimit 后续加入
  plan 对应额度、功能、周期

admin:
  账户余额
  账本流水
  用量记录
  pricing rule
  人工调整入口
```

扣费入口建议：

```text
agent/tool/model 调用前:
  credit.quote 或 credit.hold

调用成功:
  credit.capture 或 credit.spend

调用失败:
  credit.release

不需要强一致的场景:
  先 usage record，后 async settle
```

不做：

- 不管理套餐商品。
- 不对接支付 provider。
- 不决定模型 fallback。
- 不直接读 agent 内部状态。

跨模块关系：

```text
payment:
  支付成功后请求 credit grant/entitlement

model:
  model label 和 usage 用于定价

agent/session:
  上报 requestId、featureKey、idempotencyKey
```

## kokoro-payment

定位：套餐、订单、订阅、支付事件、退款记录、支付 provider 配置的权威模块。

已具备：

- Plan。
- Order。
- Subscription。
- PaymentEvent。
- Refund。
- order idempotency conflict。
- payment event idempotency conflict。
- admin manifest。

关键判断：

- 不自研支付网关。
- 不自己从 0 实现支付宝/微信/Stripe/Paddle 的收单全流程。
- 支付 provider 的签名、下单、退款、回调验签、发票能力优先使用官方 SDK 或成熟库。
- Kokoro-payment 只保存 Kokoro 需要的订单、套餐、provider 映射、回调事件、审计和状态。

Stripe 官方文档提供 Checkout、订阅和 Webhooks 等完整能力，适合我们把 provider adapter 做薄。国内支付宝/微信支付也应走官方 API/SDK，进入实现前必须按当时最新官方文档复核签名、证书、回调、退款和对账要求。

参考：

- https://docs.stripe.com/payments/checkout
- https://docs.stripe.com/billing/subscriptions/build-subscriptions
- https://docs.stripe.com/webhooks

后续必须补齐：

```text
plan:
  plan key
  price/currency/interval
  feature bundle metadata
  active/disabled

provider config:
  provider=stripe/alipay/wechat/paddle/lemon_squeezy
  merchant/app id
  secretRef/certRef
  enabled status
  webhook endpoint mapping

order:
  create checkout/session
  pending/paid/canceled/refunded
  providerOrderId
  idempotency conflict

subscription:
  providerSubscriptionId
  currentPeriodStart/currentPeriodEnd
  active/canceled/past_due

payment event:
  provider + eventId 唯一
  raw payload
  received/processed/failed
  可重放

refund:
  refund request
  provider refund id
  succeeded/failed
  对应 credit refund 或权益回收

admin:
  plan 管理
  订单查询
  订阅状态
  支付事件重放
  provider 配置状态
```

不做：

- 不直接写 credit ledger。
- 不保存支付密钥明文。
- 不自己实现完整支付后台。
- 不决定用户权限。

跨模块关系：

```text
user:
  order.teamId 必须属于有效团队

credit:
  payment success -> grant entitlement/credits
  refund success -> credit refund/revoke

admin:
  支付事件重放要有权限和审计
```

## kokoro-platform-kit

定位：非业务技术工具包。

可以放：

```text
HTTP envelope
healthz
startHttpServer
admin manifest schema
通用金额/BigInt parsing
通用错误 envelope 类型
```

不可以放：

```text
user/payment/model/credit DTO
RPC interface
OpenAPI schema
业务策略
跨模块编排
provider SDK
```

命名后续可考虑改成 `kokoro-service-kit`，更准确表达“服务模块技术套件”，避免误解成业务平台核心。

## kokoro-litellm

定位：LiteLLM 官方网关部署配置，不是业务子仓。

负责：

```text
LiteLLM config example
docker compose example
healthcheck
接入说明
```

不负责：

```text
LiteLLM 源码
模型业务权威
扣费账本
用户权限
音乐/视频/图片 provider 的直接适配
```

和 `kokoro-model` 的关系：

```text
model binding:
  transportKind=litellm
  gatewayModelName=LiteLLM model_name

LiteLLM:
  负责网关请求、key、routing、provider proxy

Kokoro:
  负责模型展示、功能可用性、业务 fallback、套餐权限和 credit usage 上报
```

## 跨模块主流程

### 登录和团队上下文

```text
web/session -> kokoro-user.ensure
kokoro-user -> user + personal team + membership
web/admin -> 根据 role/permission 展示模块入口
```

### 模型调用

```text
agent/session
  -> kokoro-model resolve model binding
  -> kokoro-credit quote/hold
  -> LiteLLM 或 direct provider
  -> kokoro-credit capture/spend + usage record
```

### 支付购买

```text
web/admin
  -> kokoro-payment create order/session
  -> provider checkout
  -> provider webhook
  -> kokoro-payment record event
  -> kokoro-payment process event
  -> kokoro-credit grant entitlement/credits
```

### 退款

```text
admin/payment
  -> provider refund
  -> payment event
  -> kokoro-payment refund record
  -> kokoro-credit refund/revoke entitlement
```

## 近期实现顺序

建议优先级：

```text
P0:
  子仓 README 更新到真实 DDD 结构
  admin manifest 和权限 key 统一
  requestId/idempotencyKey 贯穿
  user role permission checker

P1:
  model provider account 主账号/兜底账号/health check
  model binding resolve API
  credit quote/hold/capture/release
  payment provider config 和 webhook replay skeleton

P2:
  admin web 统一壳子读取 manifest
  plan -> entitlement/credit grant
  model label -> plan feature bundle
  usage record 对账

P3:
  payment provider adapters
  LiteLLM virtual key 同步
  service account runtime auth
  audit log 全模块覆盖
```

## 需要守住的红线

- 不恢复 InMemory runtime fallback。
- 不建中央业务契约子仓。
- 不让 `kokoro-platform-kit` 放业务 DTO。
- 不让每个业务子仓各自做完整后台 Web。
- 不让 payment 直接改 credit 账本。
- 不让 model 直接扣费。
- 不让 agent/session 直接写 platform 表。
- 不在共享库上跑 root `db:dev`。
