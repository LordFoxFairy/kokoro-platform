# 05 kokoro-web / admin / SEO 多站点设计

本文定义多站点前台、后台和 SEO 增长体系。

## 核心判断

```text
kokoro-web 是多站点前台壳子。
kokoro-site 提供站点配置。
admin 默认站点隔离。
SEO 是每个站点的长期资产，不是换皮文案。
```

## 前台请求链路

```text
Host
  -> kokoro-site resolve
  -> SiteContext
  -> load SiteBrand/SiteApp/SiteSeoConfig
  -> SSR/metadata
  -> user auth
  -> platform API with SiteContext headers
```

web 必须承担：

- host -> site 解析。
- SSR metadata。
- 站点主题和 i18n namespace。
- 站点 app 导航。
- 注册/登录时传 siteId。
- API 请求统一注入 SiteContext。
- sitemap.xml 和 robots.txt 站点化。

## 多站点前台结构

同一个代码库可以服务多个站点：

```text
music.example.com
video.example.com
image.example.com
zeze.work
brand-a.example.com
```

但页面配置来自 site：

```text
themeKey
layoutKey
copyNamespace
enabledApps
landingRoute
seoRouteConfig
pricingRouteConfig
```

## admin 视角

### Platform Admin

平台超级后台：

```text
管理所有 Site
管理 provider accounts
管理 plan templates
查看跨站成本、收入、风控、模型健康
切换 site 诊断
```

### Site Admin

站点后台：

```text
只能访问当前 site
管理站点用户
管理站点订单/订阅
管理站点积分和人工调整
管理站点 SEO 页面
管理站点公开 artifact/template
管理站点模型可见性
```

所有后台 API 默认要求：

```text
siteId
actorUserId
requiredPermission
```

## SEO 页面矩阵

### music 站

```text
/ai-song-generator
/lyrics-generator
/text-to-song
/genre/pop
/genre/lofi
/use-cases/youtube-intro-music
/templates/podcast-intro
/examples
/pricing
```

### video 站

```text
/ai-video-generator
/text-to-video
/image-to-video
/use-cases/product-demo
/use-cases/tiktok-ad
/templates/youtube-short
/examples
/pricing
```

### image 站

```text
/ai-image-generator
/style/anime
/style/product-photo
/use-cases/avatar
/templates/social-post
/examples
/pricing
```

### code 站

```text
/ai-code-agent
/use-cases/refactor
/use-cases/test-generation
/templates/nextjs
/templates/python
/examples
/pricing
```

## SEO 数据归属

```text
SiteSeoConfig:
  routePattern
  titleTemplate
  descriptionTemplate
  canonicalPolicy
  robotsPolicy
  sitemapPriority
  structuredDataKind

SeoPage:
  siteId
  route
  locale
  title
  description
  bodyBlocks
  status

SeoTemplate:
  siteId
  appKey
  templateKey
  routePattern
  contentSchema
```

## SEO 渲染要求

每个 indexable 页面必须稳定输出：

```text
title
description
canonical
robots
open graph
twitter card
structured data，按页面类型选择
```

站点 sitemap：

```text
/{sitemap.xml}
  包含当前 site 的可索引页面。
  不包含其它 site 页面。
```

站点 robots：

```text
/{robots.txt}
  按 site policy 输出。
```

## canonical 策略

同类页面跨站点重复时：

```text
如果是不同产品角度:
  重写内容，保留各自 canonical。

如果只是镜像页面:
  指向主站 canonical 或 noindex。
```

禁止批量生成只有关键词替换的薄页面。

## 结构化数据

可以使用：

```text
Product / Offer:
  pricing 页面、套餐页面。

SoftwareApplication:
  工具型 landing page。

FAQPage:
  真实 FAQ。

CreativeWork:
  公开模板、案例、作品。
```

结构化数据必须与页面可见内容一致。

参考：

- Google canonical: https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls
- Google JavaScript SEO: https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics
- Google Product structured data: https://developers.google.com/search/docs/appearance/structured-data/product
- Google helpful content: https://developers.google.com/search/docs/fundamentals/creating-helpful-content

## 增长和归因

每个站点都要支持：

```text
sourceSite
utmSource
utmCampaign
landingRoute
signupRoute
firstCapabilityUsed
firstPaidOffer
```

这些不是 SEO 元数据，而是业务分析字段。它们用于判断不同站点的获客质量和转化。

## 风险

- 多站点共用页面内容会变成重复/薄内容。
- 客户白标站被错误加入公开 sitemap 会暴露数据。
- 只做 CSR metadata 会影响搜索引擎理解页面。
- admin 如果不带 siteId 过滤，会产生严重越权。

## 验收标准

- 每个 host 输出不同 metadata。
- 每个 site 独立 sitemap。
- site admin 无法查看其它 site 数据。
- pricing 页面结构化数据和实际 offer 一致。
- public artifact 页面只在所属 site canonical host 下可索引。
