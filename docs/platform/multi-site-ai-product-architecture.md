# Kokoro 多站点 AI 产品工厂架构

本文定义 Kokoro 后续多站点、多产品、多能力复用的总架构。核心目标不是做一个 SaaS 多租户后台，而是做一个 AI 产品工厂：每个站点都是独立 AI 产品实例，底层复用同一套平台能力。

## 一句话

```text
站点独立，平台复用。
siteId 是第一业务隔离边界。
同邮箱跨站注册默认是不同用户。
```

## 细化分册

本文件是总纲。更细的设计按下面顺序阅读：

```text
docs/platform/multi-site/00-principles-and-invariants.md
  不可变原则、反例和验收基线。

docs/platform/multi-site/01-site-control-plane.md
  kokoro-site 站点控制面。

docs/platform/multi-site/02-user-workspace-identity.md
  kokoro-user 站点化、同邮箱跨站独立账号、workspace 和权限。

docs/platform/multi-site/03-payment-credit-billing.md
  payment/credit 站点化、套餐、offer、积分包、权益、定价、扣费闭环。

docs/platform/multi-site/04-model-agent-session-artifact.md
  model 站点可见性、agent/session/job/artifact SiteContext 继承。

docs/platform/multi-site/05-web-admin-seo.md
  多站点 web/admin/SEO、站点内容矩阵、canonical/sitemap/结构化数据。

docs/platform/multi-site/06-roadmap-and-acceptance.md
  分阶段落地路线、反例测试、风险和完成定义。
```

## 为什么这样设计

Kokoro 后续会同时承载多种 AI 产品：

```text
zeze.work             通用 AI 工作台
music.example.com     独立音乐 AI 产品
video.example.com     独立视频 AI 产品
image.example.com     独立图片 AI 产品
code.example.com      独立代码 Agent 产品
brand-a.example.com   白标客户 A
```

这些站点从用户视角看不是同一个应用的不同 tab，而是不同产品。它们需要有独立品牌、独立域名、独立注册、独立套餐、独立免费额度、独立 SEO 内容、独立运营活动和独立后台视角。

如果按全局邮箱合并用户，会带来问题：

- music 站注册送的免费额度会和 video 站混在一起。
- music 站购买的套餐可能污染 video 站权益。
- 白标客户之间会出现“同邮箱账号已存在”的隐私和品牌问题。
- 某站点封禁、注销、风控、客服状态会影响其它站点。
- SEO、转化、LTV、渠道归因无法按独立产品分析。

但如果每个站点都复制一套 user/payment/credit/model/agent，又会导致维护成本爆炸。正确形态是：

```text
前台产品无限分化。
后台平台高度复用。
所有业务数据按 siteId 隔离。
```

## 核心原则

1. `siteId` 是第一业务边界。
2. 同邮箱在不同 `siteId` 下默认创建不同 `User`。
3. workspace/team 默认按站点隔离。
4. 套餐、订单、订阅、免费额度、积分包默认按站点隔离。
5. 充值积分默认也是站点隔离；跨站通用积分必须作为显式产品能力设计。
6. Provider account、模型 adapter、支付 provider SDK、agent runtime 可以平台复用。
7. 模型可见性、能力开关、价格、权益、SEO 页面按站点配置。
8. 任何业务模块不能自己从 host 推断站点，必须消费统一 `SiteContext`。
9. 后台查询默认带 `siteId` 过滤，平台超级后台才允许跨站查看。
10. 所有跨站共享都是显式能力，不允许默认串联。

## 概念表

```text
Site
  一个独立 AI 产品实例，例如 music 站、video 站、白标站。

SiteDomain
  域名到 Site 的绑定，例如 music.example.com -> site_music。

SiteBrand
  logo、主题、文案、i18n namespace、导航、布局皮肤。

SiteApp
  站点启用的应用，例如 general-chat、music-studio、video-studio。

SitePolicy
  站点策略：注册策略、workspace 策略、钱包策略、模型策略、SEO 策略。

SiteContext
  每个请求解析出的站点上下文。

App
  一个产品能力入口，例如 music、video、image、code、general。

Surface
  使用形态，例如 general、studio、api、admin、public-seo。

Capability
  可计费或可授权能力，例如 music.studio.generate。
```

## SiteContext

每个公网请求先由 web/gateway 根据 host 解析站点：

```text
Host: music.example.com
  -> siteId = site_music
  -> siteKey = music
  -> appKey = music
  -> surface = studio
```

内部服务调用必须携带：

```text
x-kokoro-site-id
x-kokoro-site-key
x-kokoro-app-key
x-kokoro-surface
x-kokoro-request-id
x-kokoro-user-id
x-kokoro-workspace-id
```

规则：

- web/gateway 负责 host -> site 解析。
- user/payment/credit/model/agent 只消费 `SiteContext`。
- 子服务不得直接读取 host 决定站点。
- 缺失 `siteId` 的业务写请求必须拒绝，除非是平台 root admin 操作。

## 子仓库技术和业务方案

### kokoro-site

定位：站点控制面，是多站点 AI 产品工厂的入口权威。

负责：

```text
Site
SiteDomain
SiteBrand
SiteApp
SitePolicy
SiteSeoConfig
SiteRuntimeConfig
```

关键能力：

- 根据 host 解析 `SiteContext`。
- 管理站点启用哪些 app 和 capability。
- 管理站点品牌、主题、导航、默认语言。
- 管理站点 SEO 配置、sitemap 策略、robots 策略。
- 管理站点计费策略指针，例如默认 offer、价格策略、免费额度策略。
- 给 web/admin/gateway 提供只读缓存接口。

数据建议：

```text
sites:
  id, key, name, status, defaultLocale, timezone

site_domains:
  siteId, host, status, isPrimary, canonicalHost

site_apps:
  siteId, appKey, surface, status, defaultRoute

site_brand_configs:
  siteId, themeKey, logoUrl, copyNamespace, layoutKey, metadata

site_policies:
  siteId, policyKey, policyValue

site_seo_configs:
  siteId, routePattern, titleTemplate, descriptionTemplate,
  canonicalPolicy, robotsPolicy, structuredDataKind, sitemapPriority
```

部署：

- `kokoro-site` 可以独立服务，也可以第一阶段作为 platform 内部模块。
- host 解析结果需要缓存，但权威数据在 MySQL。
- 缓存可以后置 Redis；不能把站点配置只放进进程内存。

### kokoro-user

定位：站点内身份、workspace、成员、权限权威。

当前设计需要从全局用户改成站点用户：

```text
User:
  siteId
  emailNormalized
  status
  profile

ExternalIdentity:
  siteId
  provider
  providerSubject
  userId

Workspace/Team:
  siteId
  ownerUserId

Membership:
  siteId
  workspaceId
  userId
  role
```

唯一约束：

```text
unique(siteId, emailNormalized)
unique(siteId, provider, providerSubject)
unique(siteId, personalOwnerUserId)
unique(siteId, workspaceId, userId)
```

默认行为：

- 同邮箱跨站点注册，创建不同 `User`。
- 每个站点创建自己的 personal workspace。
- 站点注销、禁用、封禁只影响当前站点。
- 跨站账号绑定以后可以做，但必须是显式 `AccountLink`，不能默认合并。

为什么：

- 保护独立产品心智。
- 保护白标客户数据边界。
- 支持每站独立套餐、免费额度、客服和风控。
- 支持按站点统计注册、留存、转化。

### kokoro-payment

定位：站点内售卖、订单、订阅、支付事件权威。

拆分两层：

```text
PlanTemplate:
  平台复用的套餐模板，例如 creator_pro、music_pro、video_pro。

SiteOffer:
  某站点实际售卖的套餐。
```

建议模型：

```text
PlanTemplate:
  id, key, name, defaultBenefits, status

SiteOffer:
  id, siteId, planTemplateId, offerKey, name,
  currency, amountMinor, billingInterval,
  trialPolicy, discountPolicy, status

Order:
  siteId, userId, workspaceId, offerId, amountMinor,
  currency, status, provider, providerOrderId, idempotencyKey

Subscription:
  siteId, workspaceId, offerId, providerSubscriptionId,
  currentPeriodStart, currentPeriodEnd, status

PaymentEvent:
  siteId, provider, eventId, eventType, payload, status
```

业务规则：

- music 站订单不影响 video 站。
- 每个站点可以使用同一个 `PlanTemplate`，但价格和展示由 `SiteOffer` 决定。
- 优惠码、试用、折扣默认按 site 生效。
- 支付 provider 可以平台复用，merchant/app id 可以按站点配置。
- 支付成功后不直接写 credit 表，而是调用 credit 的 grant/entitlement API。

### kokoro-credit

定位：站点内钱包、积分包、权益、计价、冻结、扣费、账本权威。

当前 `balanceMicros` 只能支撑 P0，后续必须引入 bucket 和 entitlement。

建议模型：

```text
CreditAccount:
  siteId
  ownerKind = user | workspace
  ownerId
  status

CreditBucket:
  siteId
  accountId
  source = free_trial | free_monthly | subscription | topup | admin_grant | refund
  originalMicros
  remainingMicros
  expiresAt
  priority
  restrictionPolicy

CreditLedgerEntry:
  siteId
  accountId
  bucketId
  amountMicros
  reason
  balanceAfterMicros
  idempotencyKey

CreditHold:
  siteId
  accountId
  amountMicros
  status
  expiresAt
  idempotencyKey

EntitlementGrant:
  siteId
  workspaceId
  sourceKind = offer | admin | promotion
  sourceId
  capabilityKey
  surface
  limitPolicy
  validFrom
  validUntil

PricingRule:
  siteId
  appKey
  surface
  capabilityKey
  modelLabel
  unit
  amountMicros
  discountPolicy
  priority
  effectiveFrom
  effectiveUntil
```

扣费闭环：

```text
quote
  计算预计价格，检查 entitlement。

hold
  冻结预计积分，写 hold，避免长任务超扣。

capture
  任务成功后按实际用量结算，写 ledger 和 usage。

release
  任务失败或取消时释放 hold。

refund
  退款或补偿时写反向 ledger。
```

默认扣费顺序：

```text
1. 当前 site 的即将过期免费/试用 bucket
2. 当前 site 的订阅周期 bucket
3. 当前 site 的充值 topup bucket
4. 当前 site 的 admin/refund bucket
```

跨站通用积分：

- 默认不支持。
- 如果需要，作为独立产品 `CrossSiteCreditPass` 或 `GlobalCreditBundle` 设计。
- 即使支持，也必须在 ledger 里记录消费站点和资金来源，不能和站点钱包混写。

### kokoro-model

定位：模型配置、provider account、binding、label、站点可见模型权威。

复用和隔离的边界：

```text
ProviderAccount:
  可以平台复用，保存 provider、secretRef、priority、healthStatus。

ModelBinding:
  可以平台复用，定义 provider/model/transport/modalities。

SiteModelPolicy:
  决定某 site 能看到哪些 model label、哪些 capability 可用。

PricingRule:
  不放在 model，仍由 credit 管。
```

建议模型：

```text
SiteModelPolicy:
  siteId
  appKey
  capabilityKey
  modelBindingId
  labelKey
  status
  priority
  fallbackGroup
```

业务规则：

- 同一个 Suno/Tad/Runway/OpenAI provider 可以被多个站点复用。
- 每个站点可见的模型、默认模型、fallback 顺序独立。
- provider 成本和健康检查平台统一治理。
- 价格和权益由 credit/payment/site 决定，不由 model 决定。

### kokoro-agent / kokoro-session

定位：站点上下文内的对话、任务、工具调用、agent 编排。

所有核心数据必须带：

```text
siteId
appKey
surface
userId
workspaceId
capabilityKey
```

业务规则：

- agent 不直接扣余额。
- agent 只发起 `quote/hold/capture/release`。
- music studio、video studio、general chat 是不同 `surface/capability`。
- handoff/subagent/tool 调用必须继承 `SiteContext`。
- session/job/artifact 不能跨站查询。

运行链路：

```text
web -> siteContext -> session/agent
agent -> credit.quote
agent -> credit.hold
agent -> model.resolve
agent -> provider/tool
agent -> artifact/job result
agent -> credit.capture 或 release
```

### kokoro-artifact，后置

定位：站点内项目、产物、素材、导出文件和公开作品页。

建议模型：

```text
Project:
  siteId, workspaceId, appKey, name, status

Artifact:
  siteId, workspaceId, projectId, appKey, artifactType,
  visibility = private | unlisted | public

Asset:
  siteId, artifactId, storageKey, mimeType, size
```

SEO 相关：

- public artifact 可以生成站点内案例页。
- public template 可以作为长期 SEO 资产。
- 白标站默认关闭跨站公开索引。

### kokoro-web / admin

定位：多站点前台和统一后台壳子。

web 必须做：

- 根据 host 解析 `SiteContext`。
- SSR 输出站点级 metadata。
- 按站点加载 theme、i18n、导航、app 列表。
- 登录、注册、workspace 初始化都带 `siteId`。
- API 请求统一携带 `SiteContext` headers。

admin 必须做：

- 默认以站点为过滤边界。
- platform super admin 可以切站点。
- site admin 只能看本 site 的用户、订单、积分、job、artifact。
- 每个子仓通过 admin manifest 暴露资源和操作。

## SEO 和站点铺设玩法

每个 AI 站点都需要独立 SEO 资产，而不是只换皮。

### 页面矩阵

music 站：

```text
/ai-song-generator
/lyrics-generator
/text-to-song
/genre/pop
/genre/lofi
/use-cases/youtube-intro-music
/templates/podcast-intro
/examples
```

video 站：

```text
/ai-video-generator
/text-to-video
/image-to-video
/use-cases/product-demo
/use-cases/tiktok-ad
/templates/youtube-short
/examples
```

image 站：

```text
/ai-image-generator
/style/anime
/style/product-photo
/use-cases/avatar
/templates/social-post
/examples
```

code 站：

```text
/ai-code-agent
/use-cases/refactor
/use-cases/test-generation
/templates/nextjs
/templates/python
```

### SEO 配置归属

`kokoro-site` 保存 SEO 策略：

```text
routePattern
titleTemplate
descriptionTemplate
canonicalHost
robotsPolicy
sitemapPolicy
structuredDataKind
localePolicy
```

`kokoro-web` 负责渲染：

```text
title
description
canonical
robots
open graph
twitter card
structured data
sitemap.xml
robots.txt
```

### 内容原则

- 每个站点必须有独立内容角度，不能只替换关键词。
- 同类页面跨站点重复时必须明确 canonical 或改写内容。
- JS 渲染页面必须保证关键 metadata、canonical、结构化数据稳定输出。
- 套餐页、工具页、模板页、公开案例页可以使用结构化数据，但必须真实反映页面内容。
- 不批量生成薄内容；SEO 页面必须能把用户带到可用工具或真实示例。

参考：

- Google Search Central canonical: https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls
- Google Search Central JavaScript SEO: https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics
- Google Search Central Product structured data: https://developers.google.com/search/docs/appearance/structured-data/product
- Google Search Central helpful content: https://developers.google.com/search/docs/fundamentals/creating-helpful-content

## 计费示例

用户在 `music.example.com` 生成一首歌：

```text
1. web 解析 site_music。
2. user 创建或读取 site_music 下的 User。
3. workspace 选择 site_music 下的 workspace。
4. agent 发起 capability=music.studio.generate。
5. credit 查 site_music 的 EntitlementGrant。
6. credit 匹配 site_music 的 PricingRule。
7. credit 从 site_music 的 bucket 扣费。
8. model 根据 site_music 的 SiteModelPolicy 解析模型。
9. provider 执行生成。
10. artifact 保存 site_music 下的音频产物。
```

同邮箱去 `video.example.com`：

```text
1. siteId 变为 site_video。
2. user 是另一个 User。
3. workspace 是另一个 workspace。
4. credit account 是另一个钱包。
5. payment subscription 是另一个订阅。
```

这两个站点默认互不影响。

## 迁移阶段

### P0: 设计固化

- 新增本文档。
- 明确 `siteId` 是第一业务边界。
- 暂不改现有 schema。

### P1: kokoro-site

- 新建 `kokoro-site` 子仓。
- 实现 Site/SiteDomain/SiteApp/SiteBrand/SitePolicy。
- 提供 host -> SiteContext API。
- web/gateway 开始传 `SiteContext` headers。

### P2: user 站点化

- User/Team/Membership/Invite/ServiceAccount/AuditLog 加 `siteId`。
- 唯一约束改为 `siteId + email/external identity`。
- `POST /users/ensure` 必须要求 `siteId`。
- personal workspace 按站点创建。

### P3: payment/credit 站点化

- Order/Subscription/PaymentEvent/Refund 加 `siteId`。
- Plan 拆为 PlanTemplate + SiteOffer。
- CreditAccount/CreditBucket/Ledger/Hold/Usage/Pricing/Entitlement 加 `siteId`。
- 实现 quote/hold/capture/release。

### P4: model/agent/session/artifact 站点化

- SiteModelPolicy 控制站点模型可见性。
- Conversation/Job/Run/Artifact/Project 全部加 `siteId`。
- agent 工具调用继承 `SiteContext`。

### P5: SEO 产品化

- `kokoro-site` 保存 SEO config。
- `kokoro-web` 生成站点 sitemap/robots/metadata。
- 每个 app 建立页面矩阵和模板内容系统。

## 红线

- 不用全局 email 唯一约束。
- 不默认跨站合并用户。
- 不默认跨站共享积分。
- 不默认跨站共享 workspace。
- 不让 payment 直接扣 credit。
- 不让 model 决定价格。
- 不让 agent 自己改余额。
- 不让子服务从 host 猜 site。
- 不把 SEO 页面做成只替换关键词的薄内容。
- 不让白标站数据进入其它站点后台视图。

## 最终形态

```text
kokoro-site      站点实例、域名、品牌、策略、SEO
kokoro-user      站点内用户、workspace、成员、权限
kokoro-payment   站点内 offer、订单、订阅、支付事件
kokoro-credit    站点内钱包、bucket、权益、计价、扣费、账本
kokoro-model     平台模型复用 + 站点模型可见性
kokoro-agent     站点上下文内 agent/job/tool 编排
kokoro-session   站点上下文内会话
kokoro-artifact  站点上下文内项目、产物、公开案例
kokoro-web       多站点前台、SEO、入口、admin 壳子
```

这个设计让 Kokoro 能不断孵化新的 AI 产品站点，同时保持底层能力统一维护。
