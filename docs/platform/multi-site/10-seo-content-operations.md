# 10 SEO 内容运营和站点增长设计

本文补齐每个 AI 站点如何建设 SEO 资产、避免薄内容、追踪增长效果。

## 核心判断

```text
SEO 不是站点换皮。
SEO 是每个站点的内容资产和获客系统。
每个站点必须有独立内容角度、独立页面矩阵、独立转化路径。
```

## 页面类型

```text
Tool Landing
  核心工具页，例如 /ai-song-generator。

Use Case
  场景页，例如 /use-cases/youtube-intro-music。

Template
  模板页，例如 /templates/podcast-intro。

Example Gallery
  公开案例页，例如 /examples。

Comparison
  方案对比页，例如 /alternatives/suno。

Pricing
  套餐页，绑定 SiteOffer。

Guide
  教程页，例如 /guides/how-to-write-song-prompt。

Public Artifact
  用户公开作品页。
```

## 内容模型

```text
SeoPage
  siteId
  route
  locale
  pageType
  title
  description
  h1
  bodyBlocks
  primaryCapabilityKey
  targetIntent
  status

SeoBlock
  type = hero | steps | examples | faq | pricing | gallery | cta
  content
  source

SeoKeywordCluster
  siteId
  clusterKey
  intent = create | learn | compare | buy | troubleshoot
  primaryKeyword
  secondaryKeywords

SeoExperiment
  siteId
  route
  variant
  metric
  status
```

## 页面质量标准

每个可索引页面必须回答：

```text
用户来这里要完成什么？
这个页面是否能直接进入工具？
是否有真实示例或模板？
是否解释了能力限制和价格？
是否和其它站点页面有不同角度？
```

禁止：

```text
只替换关键词的模板页。
没有工具入口的空文章。
同一内容多站重复收录。
结构化数据和页面内容不一致。
公开用户作品未获得授权就索引。
```

## 站点内容矩阵

music 站内容角度：

```text
生成歌曲
生成歌词
生成伴奏
播客片头
YouTube intro
游戏 BGM
广告音乐
不同 genre/style
```

video 站内容角度：

```text
text to video
image to video
product demo
shorts/reels/tiktok
广告视频
教程视频
角色动画
```

image 站内容角度：

```text
avatar
product photo
anime style
social post
logo concept
storyboard
```

code 站内容角度：

```text
bug fix
test generation
refactor
code review
framework migration
documentation
```

## Canonical 和重复内容

策略：

```text
同一站点参数页:
  canonical 到主 route。

跨站点类似工具页:
  如果产品角度不同，内容必须独立。
  如果只是镜像，noindex 或 canonical 到主站。

白标站:
  默认 noindex，除非客户明确开启 SEO。

公开 artifact:
  canonical 到所属 site 的 primary domain。
```

## Sitemap 策略

每个站点独立 sitemap：

```text
/sitemap.xml
/sitemaps/pages.xml
/sitemaps/templates.xml
/sitemaps/examples.xml
```

只包含：

```text
当前 site
status = published
robotsPolicy = index
canonicalHost = 当前 host
```

## SEO 到产品转化

每个 SEO 页面都要绑定：

```text
primaryCapabilityKey
defaultPromptTemplate
defaultModelLabel
ctaRoute
offerId，可选
```

这样用户从 SEO 页面进入后，不是看完文章离开，而是直接进入可用工具。

## 增长归因

记录：

```text
landingSiteId
landingRoute
landingPageType
utmSource
utmCampaign
signupSiteId
firstCapabilityUsed
firstSuccessfulJobId
firstOfferViewed
firstCheckoutStarted
firstPaymentSucceeded
```

指标：

```text
SEO visit -> signup
signup -> first successful generation
first generation -> paywall
paywall -> checkout
checkout -> paid
SEO page cost -> paid conversion
```

## 官方原则

设计遵守：

- canonical 明确，避免重复 URL 分散信号。
- JavaScript 页面要稳定输出关键 metadata 和可索引内容。
- Product/Offer structured data 必须真实反映套餐和价格。
- 内容必须帮助用户完成真实任务，避免批量薄内容。

参考：

- https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls
- https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics
- https://developers.google.com/search/docs/appearance/structured-data/product
- https://developers.google.com/search/docs/fundamentals/creating-helpful-content

## 验收标准

- 每个站点有独立 sitemap。
- 每个 indexable 页面有 capability 入口。
- 白标站默认 noindex。
- pricing structured data 与 SiteOffer 一致。
- 每个 SEO 页面能追踪到 signup、first job、payment。
