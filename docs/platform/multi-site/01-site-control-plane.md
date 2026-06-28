# 01 kokoro-site 站点控制面

`kokoro-site` 是多站点 AI 产品工厂的入口权威。它不管理用户余额、不处理订单、不执行 agent；它只回答一个问题：当前请求属于哪个独立 AI 产品站点，以及这个站点应该如何运行。

## 职责

```text
Site:
  站点实例。

SiteDomain:
  域名绑定和 canonical host。

SiteBrand:
  品牌、主题、文案命名空间、导航、布局。

SiteApp:
  站点启用的 app/surface/capability。

SitePolicy:
  注册、workspace、钱包、模型、支付、SEO 策略。

SiteSeoConfig:
  title、description、canonical、robots、sitemap、structured data。

SiteRuntimeConfig:
  前台运行配置、功能开关、默认模型标签、默认落地页。
```

## 数据模型草案

```text
Site
  id
  key
  name
  status = draft | active | disabled
  defaultLocale
  timezone
  ownerKind = platform | customer
  metadata

SiteDomain
  id
  siteId
  host
  status = pending | active | disabled
  isPrimary
  canonicalHost
  verifiedAt

SiteBrandConfig
  id
  siteId
  themeKey
  logoUrl
  faviconUrl
  layoutKey
  copyNamespace
  navigationJson
  metadata

SiteApp
  id
  siteId
  appKey
  surface
  status = active | disabled
  defaultRoute
  priority

SiteCapability
  id
  siteId
  appKey
  capabilityKey
  status = active | disabled
  requiredEntitlementKey

SitePolicy
  id
  siteId
  policyKey
  policyJson
  status

SiteSeoConfig
  id
  siteId
  routePattern
  titleTemplate
  descriptionTemplate
  canonicalPolicy
  robotsPolicy
  structuredDataKind
  sitemapPriority
  metadata
```

## SiteContext 解析

入口链路：

```text
HTTP Host
  -> kokoro-site.resolve(host, path)
  -> SiteContext
  -> web/admin/gateway 注入 headers
  -> 下游服务消费 headers
```

SiteContext：

```text
siteId
siteKey
host
canonicalHost
appKey
surface
brandKey
locale
requestId
```

认证后补：

```text
userId
workspaceId
role
permissions
```

## 缓存策略

站点配置读取频繁，但不能只放内存。

第一阶段：

```text
MySQL 权威
进程内短 TTL cache
配置变更后允许最多 30-60s 生效
```

后续：

```text
Redis cache
site_config_version
admin 发布后广播 invalidation
```

任何缓存都不能改变权威关系：MySQL 是最终真相。

## 策略类型

```text
identityPolicy:
  site_scoped

workspacePolicy:
  site_scoped

walletPolicy:
  site_scoped

paymentPolicy:
  platform_provider | site_provider

modelPolicy:
  site_allowlist

seoPolicy:
  indexable | noindex | private

adminPolicy:
  site_admin_only | platform_managed
```

当前默认：

```text
identityPolicy = site_scoped
workspacePolicy = site_scoped
walletPolicy = site_scoped
paymentPolicy = platform_provider
modelPolicy = site_allowlist
seoPolicy = indexable
```

## 与其它子仓的关系

```text
kokoro-user:
  创建用户和 workspace 时必须传 siteId。

kokoro-payment:
  查询 SiteOffer 时必须传 siteId。

kokoro-credit:
  quote/hold/capture 必须传 siteId。

kokoro-model:
  resolve model 时使用 SiteModelPolicy。

kokoro-web:
  用 SiteBrand/SiteSeoConfig 渲染前台。

kokoro-admin:
  用 site admin 权限过滤数据。
```

## API 草案

```text
GET /sites/resolve?host=music.example.com&path=/ai-song-generator
  -> SiteContext

GET /sites/:siteId/runtime-config
  -> brand, apps, capabilities, seo defaults

POST /sites
  platform admin 创建站点

POST /sites/:siteId/domains
  绑定域名

POST /sites/:siteId/apps
  启用 app/surface

POST /sites/:siteId/policies
  修改策略
```

## 后台视角

平台超级后台：

```text
管理所有 Site。
切换 site 查看数据。
管理 provider、全局模板、部署配置。
```

站点后台：

```text
只看当前 site。
管理站点品牌、SEO、offer、用户、订单、积分、内容。
```

## 风险

- host 解析失败时不能落到默认站点执行业务写入。
- domain 变更需要 canonical 和 sitemap 同步。
- 白标站必须默认禁止跨站后台查看。
- SitePolicy 不能变成无类型大 JSON 黑洞；高频策略需要独立字段或 schema 校验。

## 验收标准

- 新增站点只需配置 Site/Domain/Brand/App/Policy。
- 同一后端服务能服务多个 host。
- 请求缺失 siteId 时，user/payment/credit 写操作拒绝。
- 站点禁用后，前台和 API 写入都拒绝。
- SEO 配置可以按 routePattern 输出 metadata/sitemap。
