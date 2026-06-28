# 07 站点生命周期和运营模型

本文补齐“站点如何从想法变成可运营 AI 产品”的完整闭环。多站点不是建很多域名，而是平台化孵化、验证、运营和下线独立 AI 产品。

## 站点生命周期

```text
Idea
  发现一个 AI 垂直机会，例如 AI Music、AI Video、AI Resume。

Draft
  创建 Site 草稿，配置域名、品牌、能力、模型、SEO 页面矩阵。

Sandbox
  内部测试，限制访问，使用测试 provider/payment。

Beta
  小流量上线，开放注册和免费额度，观察成本、转化、留存。

Launch
  正式上线，开放 SEO、付费套餐、站点后台。

Operate
  持续运营：内容、模型、价格、额度、风控、活动。

Scale
  高流量扩容、独立 provider 策略、独立支付 merchant、专属客服。

Sunset
  停止新增注册/购买，保留用户数据导出和退款路径。

Archive
  站点归档，只保留审计、订单、账本和必要合规数据。
```

## 站点状态机

```text
draft
  只允许 platform admin 配置。

sandbox
  允许内部账号访问。

beta
  允许白名单/邀请码访问。

active
  正常服务和索引。

paused
  暂停新任务，保留登录和账单。

sunsetting
  停止新注册和新购买，允许导出、退款、查看历史。

archived
  禁止业务写入，只保留审计读取。

disabled
  站点被关闭，所有访问返回明确错误或维护页。
```

站点状态影响：

```text
注册
登录
新建 workspace
新建订单
领取免费额度
发起 agent job
公开 SEO 页面
sitemap 输出
后台操作
```

## 站点上线清单

上线前必须具备：

```text
SiteDomain 已验证
canonicalHost 已配置
SiteBrand 完整
SiteApp 和 capability 已配置
SiteOffer 至少有免费或付费方案
CreditBucket/Entitlement 初始化规则存在
PricingRule 可覆盖主要能力
SiteModelPolicy 可 resolve 默认模型
SEO 首页和核心页面已配置
robots/sitemap 策略已确认
风控和限流策略存在
客服/退款/条款链接存在
```

## 产品运营对象

站点运营围绕这些对象：

```text
Acquisition:
  SEO 页面、广告 campaign、推荐链接、模板案例页。

Activation:
  首次注册、首次生成、首次保存产物。

Conversion:
  首次到达额度墙、首次 checkout、首次订阅。

Retention:
  回访、项目继续编辑、二次生成、订阅续费。

Expansion:
  增量积分包、高级模型、团队协作、API 使用。

Support:
  失败任务、退款、额度争议、内容安全申诉。
```

每个站点都需要独立分析这些数据，不能只看全平台总数。

## 站点配置分层

```text
Platform Default
  平台默认能力、默认模型、默认安全策略。

App Template
  music/video/image/code 这类应用模板。

Site Override
  某个站点自己的品牌、价格、SEO、能力开关。

Campaign Override
  某个营销活动临时免费额度、折扣、landing page。
```

优先级：

```text
Campaign Override
> Site Override
> App Template
> Platform Default
```

## 为什么不复制站点后端

复制站点后端会让这些能力无法统一升级：

```text
模型健康检查
provider fallback
支付 webhook 幂等
积分账本
内容安全
风控限流
后台审计
SEO sitemap 生成
成本毛利分析
```

所以每个站点只复制“产品配置和内容资产”，不复制平台能力。

## 为什么不共享站点业务数据

共享业务数据会破坏：

```text
品牌独立
白标隐私
套餐独立
免费额度策略
获客归因
退款责任
客服上下文
风控准确性
```

因此默认：

```text
site scoped user
site scoped workspace
site scoped wallet
site scoped order
site scoped artifact
```

## 站点下线策略

站点下线不能简单删除。

sunsetting 阶段：

```text
停止新注册
停止新购买
停止 SEO index 新页面
保留登录
允许查看历史产物
允许导出数据
允许退款/客服
保留账本审计
```

archive 阶段：

```text
关闭业务写入
只保留合规需要的订单、账本、审计
artifact 按策略删除或冷存储
搜索引擎输出 noindex 或 410/301 策略
```

## 验收标准

- 新站从 draft 到 active 有明确 checklist。
- disabled/sunsetting 状态会影响注册、支付、生成和 SEO。
- 站点运营指标能独立看 acquisition/activation/conversion/retention。
- 下线站点不会继续产生新订单或新扣费。
- archived 站点不会出现在 sitemap。
