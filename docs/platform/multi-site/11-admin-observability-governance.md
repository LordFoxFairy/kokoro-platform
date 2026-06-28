# 11 后台、指标、可观测性和治理

本文定义平台和站点运营后台应该如何支撑多站点 AI 产品工厂。

## 后台分层

```text
Platform Console
  平台超级后台，跨站管理能力和成本。

Site Console
  站点后台，只管理当前站点。

Workspace Console
  团队/个人工作区设置。

Provider Console Link
  LiteLLM、Stripe、支付平台等第三方后台链接或嵌入。
```

## Platform Console

核心页面：

```text
Sites
  站点列表、状态、域名、上线 checklist。

Capabilities
  capability catalog、启用状态、风险等级。

Models
  provider accounts、model binding、health、成本。

Billing Ops
  SiteOffer 模板、跨站收入、退款、支付事件。

Credit Ops
  账本异常、人工调整、bucket 策略。

Cost & Margin
  按 site/capability/model 的成本和毛利。

Risk
  滥用、免费额度 farming、支付异常、内容风险。

SEO Ops
  sitemap、index 状态、页面质量、重复内容。
```

## Site Console

核心页面：

```text
Overview
  注册、生成、收入、成本、转化。

Users
  当前 site 用户、workspace、成员。

Billing
  订单、订阅、退款、offer。

Credits
  钱包、bucket、ledger、人工调整。

Content
  公开 artifact、模板、SEO 页面。

Models
  本站可见模型、默认模型、fallback。

Settings
  brand、domain、SEO、policy。
```

## 指标体系

所有指标必须支持这些维度：

```text
siteId
appKey
surface
capabilityKey
modelLabel
provider
workspaceId
plan/offer
route/pageType
```

关键指标：

```text
activation:
  signup
  first_successful_generation
  first_artifact_saved

monetization:
  checkout_started
  payment_succeeded
  subscription_active
  topup_purchased

cost:
  provider_cost
  failed_job_cost
  free_quota_cost
  refund_amount

quality:
  job_success_rate
  provider_error_rate
  average_latency
  retry_rate
  refund_rate

SEO:
  indexed_pages
  organic_visits
  signup_from_seo
  first_job_from_seo
  payment_from_seo
```

## 可观测性

每个请求和任务贯穿：

```text
requestId
siteId
userId
workspaceId
jobId
providerRequestId
idempotencyKey
```

日志要求：

```text
结构化 JSON
不输出 secret/token
不输出完整支付 payload 到普通日志
provider raw response 分级存储
```

追踪链：

```text
web request
site resolve
auth/user ensure
credit quote/hold
model resolve
provider call
artifact write
credit capture/release
```

## 异常治理

必须有运营可见的异常队列：

```text
payment webhook failed
credit capture failed
job succeeded but capture failed
provider charged but job failed
artifact upload failed
sitemap generation failed
site domain verification failed
```

异常处理需要：

```text
状态机
可重试
幂等
人工操作审计
用户可解释状态
```

## 配置发布治理

站点配置变更要有：

```text
draft
review
publish
rollback
audit
```

高风险配置：

```text
pricing rule
free quota
payment provider
domain/canonical
robots policy
model allowlist
site status
```

这些不应该无审计直接生效。

## 验收标准

- site admin 只能看到本 site 数据。
- platform admin 能按 site/capability 看收入、成本和毛利。
- 每个 job 能从请求追踪到 provider 成本和 credit ledger。
- payment/credit 异常有可重试队列。
- pricing/SEO/domain/model policy 变更有审计和回滚。
