# Kokoro Platform 能力清单

成熟度：✅ 已实现 · 🟡 部分/草稿 · ⬜ 规划。租户/上下文设计见 [tenant-model.md](./tenant-model.md)。

## 横切能力（platform-kit + 网关）

| 能力 | 现状 | 说明 |
|---|---|---|
| 统一响应 sendData/sendError | ✅ | `{data}` / `{error}` + requestId |
| 金额解析 parseBigIntString | ✅ | `/^\d+$/` 守卫，micros/minor |
| admin manifest schema/route | ✅ | 模块声明 resources/actions/requiredPermission |
| OpenAPI/Swagger 注入 | 🟡 | platform-kit `registerOpenApi` 就绪，各模块未接 |
| 服务启动器 start-server | ✅ | Fastify + 优雅关闭 |
| **RequestContext + requireSite 守卫** | ⬜ | 边缘解析 siteId/principal、缺 siteId 拒写 |
| **跨服务 context 转发** | ⬜ | payment→credit 现丢 site/caller/requestId |
| **平台 RBAC 鉴权** | ⬜ | manifest requiredPermission 纯声明、零强制 |
| **运营中心审计** | ⬜ | 网关层 who/what/前后/理由/result |
| **网关写操作代理(POST)** | ⬜ | 现仅代理 GET 列表 |
| 可观测/仪表盘 | ⬜ | 收入/积分负债/用量/各站对比 |
| 风控（限速/异常/批量禁用） | ⬜ | |

## kokoro-site —— 租户权威

| 能力 | 现状 |
|---|---|
| 站点 upsert / 列表 | ✅ |
| 域名 / 应用 / 策略 / 品牌 / SEO upsert | ✅ |
| 站点上下文解析 `/site-context/resolve`(host→site) | ✅ |
| siteId-native（5/5 表带 siteId） | ✅ |
| 开站向导（编排域名+品牌+套餐+模型策略+SEO） | ⬜ |
| SiteModelPolicy（站点模型可见/分级） | ⬜ |
| 站点生命周期（suspend/resume/offboard） | 🟡 status 有，操作未接 |

## kokoro-user —— 身份权威

| 能力 | 现状 |
|---|---|
| 用户 ensure（幂等 + 个人团队） | ✅ |
| 我的团队 `/me/teams` | ✅ |
| 禁用/启用用户 | ✅（草稿，待并入 siteId 版） |
| 列表 users/teams/memberships/service-accounts | ✅ |
| **siteId 化（User/Team 站内）** | ⬜ 核心地基 |
| Membership 改角色 / ServiceAccount 吊销 | 🟡 manifest 声明、后端缺 |
| Invite 邀请流 | ⬜ 表有逻辑空 |
| 团队 RBAC（Role 表落地） | ⬜ 表有逻辑空 |
| 领域审计 UserAuditLog | ⬜ 表有逻辑空 |

## kokoro-model —— 模型目录/路由（平台共享）

| 能力 | 现状 |
|---|---|
| ProviderAccount ensure | ✅ |
| ModelBinding ensure / 列表 / **resolve（路由）** | ✅ |
| 启停 provider / binding | ✅（草稿） |
| 列表 provider/bindings/labels | ✅ |
| Provider 健康态（healthStatus 字段） | 🟡 只读，无探活写入 |
| SiteModelPolicy（按站可见/分级/按套餐可用） | ⬜ |

## kokoro-credit —— 计费权威

| 能力 | 现状 |
|---|---|
| 账户 ensure | ✅ |
| 发放 grant / 扣减 spend（原子 `balance-held>=amount`） | ✅ |
| 冻结 hold / 结算 capture / 释放 release（原子幂等） | ✅ |
| 计价 quote（PricingRule） | ✅ |
| 管理员发积分(by owner) + 账户查账 audit | ✅（草稿） |
| 列表 accounts/ledger/usage/pricing | ✅ |
| **siteId 化（Account `(siteId,ownerKind,ownerId)`）** | ⬜ 核心地基 |
| 配额/限速（spend limit/entitlement） | ⬜ |

## kokoro-payment —— 购买/订阅

| 能力 | 现状 |
|---|---|
| 套餐 upsert（含 creditMicros） | ✅ |
| 下单 createOrder（幂等） | ✅ |
| 确认 confirmOrder（pending→paid，触发发积分） | ✅ |
| 退款 refundOrder（paid→refunded，反向扣积分） | ✅（草稿） |
| 记录 PaymentEvent（webhook） | ✅ |
| 管理员授予套餐 grant-plan（不走支付发权益） | ✅（草稿） |
| 列表 plans/orders/subscriptions/events/refunds | ✅ |
| **siteId 化（Plan `(siteId,key)` + Order/Sub/Refund.siteId）** | ⬜ 核心地基 |
| 跨服务 confirm/refund 转发 context | ⬜ 现丢 site/caller |
| 真实支付渠道接入（Stripe/微信/支付宝） | ⬜ |

## kokoro-platform-admin —— 运营控制台

| 能力 | 现状 |
|---|---|
| manifest 聚合 `/api/manifests` | ✅ |
| 资源列表代理 `/api/resource`（GET，SSRF 白名单） | ✅ |
| 中文化只读仪表盘 | ✅（被否，要升级为工作台） |
| **写操作代理 `/api/action`（POST）** | ⬜ |
| **operator 认证 + 平台 RBAC + 中心审计** | ⬜ |
| **站点选择器（站点感知）** | ⬜ |
| **用户360 客服台**（一屏看全 + 发积分/退款/授予套餐/禁用） | ⬜ 第一刀 |
| 退款流 / 开站向导 / 模型运维台 / 概览风控 | ⬜ |

## 跨模块依赖

```text
site     ── 基础层，无出向依赖
user     ── 基础层，无出向依赖
model    ── 自主（平台共享）
credit   ── 计费权威，被调不外调
payment  ── 唯一跨服务方：confirm/refund → credit(/accounts/ensure + /grant|/spend)
admin    ── 聚合/代理所有模块（运营守门人）
```
无循环依赖。
