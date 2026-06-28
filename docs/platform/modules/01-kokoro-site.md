# kokoro-site 技术方案

## 定位

`kokoro-site` 是站点事实和 `SiteContext` 的权威模块。它存在的目的，是避免 web、user、credit、payment、model 各自解析域名和站点策略。

## 职责

拥有：

- Site
- SiteDomain
- SiteApp
- SitePolicy
- SiteBrandConfig
- SiteSeoConfig
- domain -> site 的解析权威

不拥有：

- 用户、团队、workspace
- 积分账户和账本
- 支付订单和订阅
- 模型 provider secret
- agent job
- artifact

## 数据模型

MySQL + Prisma。

核心表：

```text
site_sites
  id, key, name, status, defaultLocale, timezone, metadata

site_domains
  id, siteId, host, status, isPrimary, canonicalHost, metadata

site_apps
  id, siteId, appKey, surface, status, defaultRoute, metadata

site_policies
  id, siteId, key, value, status

site_brand_configs
  id, siteId, key, themeKey, logoUrl, copyNamespace, layoutKey, status, metadata

site_seo_configs
  id, siteId, routePattern, titleTemplate, descriptionTemplate,
  canonicalPolicy, robotsPolicy, structuredDataKind, sitemapPriority, status, metadata
```

唯一约束：

```text
Site.key
SiteDomain.host
SiteApp(siteId, appKey, surface)
SitePolicy(siteId, key)
SiteBrandConfig(siteId, key)
SiteSeoConfig(siteId, routePattern)
```

## API

当前接口：

```text
GET  /healthz
GET  /sites
POST /sites/upsert
POST /site-domains/upsert
POST /site-apps/upsert
POST /site-policies/upsert
GET  /site-context/resolve
```

`GET /site-context/resolve` 输入：

```text
host
appKey?
surface?
```

输出：

```text
siteId
siteKey
host
appKey?
surface?
defaultLocale
timezone
```

如果 domain 未启用、site 未 active，返回 not found。

## Admin

admin manifest：

```text
basePath: /admin/sites
resources:
  sites
  domains
  apps
  policies
```

权限 key：

```text
site.read
site.write
siteDomain.read
siteDomain.write
siteApp.read
siteApp.write
sitePolicy.read
sitePolicy.write
```

## 部署

服务名：

```text
kokoro-site
```

端口：

```text
4201
```

环境变量：

```text
DATABASE_URL_SITE
KOKORO_SITE_PORT
KOKORO_SITE_BASE_URL
```

Kubernetes 支持多副本。权威状态全部在 MySQL，不依赖进程内缓存。

## 后续任务

第一阶段：

- 补集成测试：upsert site/domain/app/policy 后 resolve。
- 增加 domain pending verification 状态流转。
- 增加 SiteContext header 输出 helper。

第二阶段：

- 站点生命周期：draft/sandbox/beta/active/suspended/archive。
- 默认站点初始化模板。
- brand/SEO 的管理 API。
- gateway/web 侧缓存策略。

验收：

- 业务子仓不解析 host。
- 所有写请求可以明确传入或推导 `siteId`。
- 同一域名只能绑定一个 active site。
