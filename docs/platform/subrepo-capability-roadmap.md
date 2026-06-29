# Kokoro Platform 子仓能力规划

本文用于约束 `kokoro-platform` 下各子仓的职责、后续补齐顺序和跨模块关系。目标不是把所有业务一次写完，而是避免后续 music studio、video、image、agent、skill hub、mcp hub、支付、积分、模型管理接入时边界混乱。

多站点 AI 产品工厂的总设计见 `docs/platform/multi-site-ai-product-architecture.md`。后续 user/payment/credit/model/agent/session/artifact 的站点化改造以该文档为准：`siteId` 是第一业务隔离边界，同邮箱跨站注册默认是不同用户。

各子仓详细技术方案见 `docs/platform/modules/README.md`。

各模块「已闭环」与「刻意未做的边界」的逐项审计结论见 `docs/platform/2026-06-29-audit-and-known-boundaries.md`，本文与其互相呼应：本文给规划与边界，审计文给逐项闭环/边界清单。

## 总原则

平台采用“业务自治，入口统一”的形态：

```text
kokoro-web / kokoro-admin
  统一登录、导航、i18n、主题、权限、后台壳子和模块页面渲染

kokoro-platform
  平台模块注册、统一验证、本地基础设施、边界约束

kokoro-site / user / model / credit / payment
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

数据库选型约束：

- 平台核心管理数据使用 MySQL：site、user、model、credit、payment。
- 后续产物型数据使用 Mongo：artifact、job result、创作内容、非结构化上下文和大 JSON 状态。
- 当前平台方案不引入 PostgreSQL，避免 MySQL/Mongo/PG 三套数据库同时维护。

## 部署策略

每个业务子仓都必须能作为独立进程运行，也必须能在 Kubernetes 中多副本运行。

统一运行面：

```text
kokoro-site      KOKORO_SITE_PORT=4201
kokoro-user      KOKORO_USER_PORT=4211
kokoro-model     KOKORO_MODEL_PORT=4221
kokoro-credit    KOKORO_CREDIT_PORT=4231
kokoro-payment   KOKORO_PAYMENT_PORT=4241
```

统一内部服务地址：

```text
KOKORO_SITE_BASE_URL=http://kokoro-site:4201
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

## kokoro-site

定位：站点、域名、应用开关、策略、品牌和 SEO 配置的权威模块。

它存在的理由不是扩大平台复杂度，而是把 `domain -> siteId` 和站点配置收敛到一个可测试边界，避免 web、user、credit、payment、model 各自解析站点。

已实现：

- Site、SiteDomain、SiteApp、SitePolicy、SiteBrandConfig、SiteSeoConfig schema。
- `POST /sites/upsert`、`POST /site-domains/upsert`、`POST /site-apps/upsert`、`POST /site-policies/upsert`：site/domain/app/policy 的 upsert。
- `GET /site-context/resolve`：按 host 规范化解析 SiteContext，未绑定/站点未 active 返回 null。
- `GET /sites`。
- admin manifest。

边界：

```text
owns:
  sites
  site domains
  site apps
  site policies
  site brand configs
  site seo configs

does not own:
  users
  teams/workspaces
  credit ledger
  payment orders
  model provider secrets
  agent jobs
  generated artifacts
```

后续/边界（需产品决策，schema/manifest 有、应用层逻辑空）：

```text
品牌/SEO:
  SiteBrandConfig / SiteSeoConfig 的解析投影（当前 resolve 不投影，表休眠）

域名:
  pending_verification -> active 验证流转
  canonicalHost 输出给网关做重定向
  TLS/证书状态由部署层或 gateway 记录引用

策略:
  SitePolicy 在 resolve 中投影给下游（注册/默认套餐/免费额度/模型可见性/team 策略）

站点:
  多 app 站点的 primary 选择策略
  draft/sandbox/beta/suspended/archive 完整生命周期
  创建站点默认 app/policy/brand/seo 初始化

缓存:
  第一阶段可以由 web/gateway 缓存 resolve 结果
  权威数据仍在 MySQL
```

## kokoro-user

定位：身份、团队、成员关系、角色、服务账号和审计的权威模块。

已实现：

- User、Team、Membership、Role、Invite、ServiceAccount、UserAuditLog schema。
- `POST /users/ensure`：ensureUserWithPersonalTeam（user + personal team + owner membership；email trim+lowercase 规范化；ensure 不复活已 disabled 用户，管理员 disable 不被登录自动解禁）。
- `GET /me/teams`：listTeamsForUser。
- admin manifest。
- MySQL + Prisma + integration tests。

后续/边界（需产品决策，表/manifest 有、应用层逻辑空）：

```text
团队/成员:
  非个人 Team / Membership 管理（创建 workspace、改 name/slug、禁用/恢复、增删成员、改角色）
  Invite 邀请（发起/接受/撤销）

权限:
  Role -> permission checker
  platform permission key registry
  admin action requiredPermission 校验
  注：admin manifest 当前暴露的 change-role/disable/revoke 等动作后端尚无对应路由

服务账号:
  ServiceAccount token 创建/rotate/revoke、token prefix + secret hash 校验

用户:
  禁用/启用用户、更新 profile、lastSeenAt、external identity 映射

审计:
  UserAuditLog 全模块写入、requestId 贯穿 HTTP/API
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

已实现：

- ProviderAccount、ModelBinding、ModelLabel schema。
- `transportKind = litellm | direct | internal`；litellm 绑定强制 `gatewayModelName`（缺失则不可路由，ensure 时拦截）。
- `POST /provider-accounts/ensure`：ensureProviderAccount（priority、status、transportKind）。
- `POST /model-bindings/ensure`：ensureModelBinding（featureKey、labelKeys、priority；同 providerAccountId + modelName + transportKind 唯一）。
- `GET /model-bindings`：listModelBindings（active，priority asc）。
- `GET /model-bindings/resolve`：resolveModelBindings——只取 active binding + provider status=active 且 healthStatus≠down，按 priority asc（createdAt 次序）返回有序候选，支持 labelKey / transportKind 过滤。
- admin manifest。

关键判断：

- LiteLLM 是 LLM 网关，不是 Kokoro 的模型业务权威。
- Kokoro-model 负责“哪些功能可以用哪些模型、优先级、账号、标签、展示、是否启用”。
- LiteLLM 负责代理、路由、虚拟 key、provider 请求和部分 spend tracking。
- 音乐、视频、图片等非 LLM provider 可以走 `direct` 或专门 adapter，不强行塞进 LiteLLM。

LiteLLM 官方文档显示它支持 virtual keys、模型访问控制、spend tracking、model aliases、budget/rate limit 等能力，因此 Kokoro 应利用它作为网关能力，而不是复制网关实现。

参考：

- https://docs.litellm.ai/docs/proxy/virtual_keys

后续/边界（需产品决策）：

```text
model label:
  ModelLabel（defaultBindingId / tier）的 label -> binding 解析兜底（表休眠）
  给前端和业务套餐用的稳定 label，不直接暴露 provider 内部命名

resolve 排序:
  degraded provider 是否在 resolve 中降权排序（当前仅排除 down，不区分 degraded）

provider account:
  主账号/兜底账号语义、secretRef（不存明文）、health check 真实写入 healthStatus

model binding:
  input/output modalities、显式 fallback policy

runtime query:
  list available models by featureKey + team plan + user permission

admin:
  provider/binding/label 管理 UI、health 状态展示、secretRef 只显示引用
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

已实现：

- 账户模型：CreditAccount 用 `balanceMicros` + `heldMicros`（无 bucket），`available = balance - held`。
- CreditLedgerEntry、CreditHold、UsageRecord、PricingRule schema。
- `POST /credit/accounts/ensure`：ensureAccount。
- `POST /credit/grant`：grantCredits（balance += amount，正向 ledger）。
- `POST /credit/spend`：spendCredits——按可用额 `balance - held >= amount` 原子条件更新，不动用已冻结资金。
- `POST /credit/quote`：纯读计价。PricingRule 按 `featureKey + labelKey` 精确优先、`labelKey=null` 通用回退，限 effective 窗口（effectiveFrom ≤ now < effectiveUntil/null）；`amount = unitAmount × quantity`。
- `POST /credit/hold`：holdCredits——原子条件 `available ≥ amount` 则 `held += amount`。
- `POST /credit/capture`：captureHold——`actual ≤ hold.amount`，`balance -= actual`、`held -= hold.amount`，写负向 ledger + settled UsageRecord。
- `POST /credit/release`：releaseHold（释放冻结）。
- 全部幂等 + 并发原子安全（条件更新/转移），余额不足领域策略。
- admin manifest。

核心原则：

- 实时扣费权威在 credit。
- agent/model/tool 不直接改余额。
- 所有余额变化必须有 ledger entry。
- 用量记录和扣费可以先同步，后续再拆为事件/队列。

后续/边界（需产品决策）：

```text
hold 过期回收:
  expiresAt / expired 字段休眠，需定惰性回收或后台 sweeper 策略

refund:
  退款专用入口及与原 ledger/usage 的回链（现 reason=refund 仅能裸 grant，无关联）

计价/用量语义:
  PricingRule.unit 的换算语义
  UsageRecord 的 recorded / failed 状态路径

权益:
  Entitlement / SpendLimit / plan 对应额度、功能、周期

账户:
  禁用账户、账户余额查询接口

admin:
  账户余额、账本流水、用量记录、pricing rule、人工调整入口 UI
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

已实现：

- Plan（含 `creditMicros`）、Order、Subscription、PaymentEvent、Refund schema。
- `POST /plans/upsert`：upsertPlan。
- `POST /orders`：createOrder（按 idempotencyKey 幂等）。
- `POST /orders/:id/confirm`：confirmOrder——`pending -> paid` 抢占式条件转移（并发确认仅一方生效、已 paid 幂等）；转 paid 前经 HTTP credit 客户端 ensure -> grant，把 `plan.creditMicros` 授予 team 账户，幂等键 `order:{id}`（先授予再标 paid，失败时 order 仍 pending、重试不重复发积分）。
- `POST /payment-events/record`：recordPaymentEvent（provider + eventId 幂等）。
- payment 不写 credit 表，授予经 HTTP 走 credit 服务（守 ADR-003）。
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

后续/边界（需产品决策，schema/manifest 有、逻辑空）：

```text
webhook 驱动:
  PaymentEvent -> order 关联，由 provider webhook 驱动 confirmOrder
  （现确认靠直接 HTTP，需定签名/证书/映射）

provider config:
  provider=stripe/alipay/wechat/paddle/lemon_squeezy
  merchant/app id、secretRef/certRef、enabled、webhook endpoint mapping

order:
  create checkout/session、providerOrderId、canceled/refunded 流转

subscription:
  Subscription 周期续费状态机（providerSubscriptionId、period、active/canceled/past_due）

refund:
  Refund 状态机（provider refund id、succeeded/failed）及对应 credit refund / 权益回收

admin:
  plan 管理、订单查询、订阅状态、支付事件重放、provider 配置状态 UI
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

可以放（已实现）：

```text
HTTP envelope / responses
healthz
startHttpServer
admin manifest schema
通用金额/BigInt parsing（parsePositiveBigIntString 加 /^\d+$/ 守卫，拒 0x/+/空白等钱款入参）
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

已完成（本轮已落地，标记不再列入待办）：

```text
[done] 子仓 README / DDD 四层结构
[done] admin manifest schema 统一
[done] idempotencyKey 贯穿 credit/payment 关键写入
[done] model binding resolve API（/model-bindings/resolve）
[done] credit quote / hold / capture / release（含原子条件更新 + 并发安全）
[done] payment confirmOrder -> credit grant（经 HTTP，order:{id} 幂等）
```

剩余建议优先级：

```text
P0:
  user role permission checker + platform permission key registry
  manifest 暴露动作（change-role/disable/revoke）补齐对应后端路由
  requestId 全链路贯穿 HTTP/API

P1:
  payment provider config 和 webhook-driven confirmOrder（签名/映射）
  model provider account health check 真实写入 + secretRef
  credit hold 过期回收策略（sweeper / 惰性）

P2:
  admin web 统一壳子读取 manifest
  plan -> entitlement，model label -> plan feature bundle
  usage record 对账、refund 回链语义

P3:
  payment provider adapters（stripe/alipay/wechat）
  Subscription 周期续费、Refund 状态机
  LiteLLM virtual key 同步
  service account runtime auth、audit log 全模块覆盖
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
