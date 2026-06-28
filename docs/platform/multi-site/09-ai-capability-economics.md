# 09 AI 能力工厂、成本和毛利设计

本文补齐 AI 能力如何被多个站点复用、如何定价、如何控制成本和毛利。

## 核心判断

Kokoro 的底层不是页面工厂，而是 AI 能力工厂。

```text
Capability 是可复用的 AI 业务能力。
Site 决定哪些 capability 对用户可见。
ModelPolicy 决定 capability 使用哪些模型。
PricingRule 决定 capability 怎么收费。
CostRecord 决定平台真实成本。
```

## Capability Catalog

建议建立平台能力目录：

```text
Capability
  key
  appKey
  surface
  inputModalities
  outputModalities
  defaultUnit
  riskLevel
  status
```

示例：

```text
general.chat.message
general.image.generate
music.studio.generate
music.studio.extend
music.lyrics.generate
video.studio.generate
video.image_to_video
image.style.generate
code.agent.run
```

能力目录是平台级，站点通过 SiteCapability 开关启用。

## 成本模型

AI 成本不是统一单位。需要支持：

```text
token
generation
second
image
video_second
tool_call
job_minute
storage_gb_day
bandwidth_gb
```

Provider 成本记录：

```text
ProviderCostRecord
  siteId
  capabilityKey
  provider
  modelBindingId
  providerAccountId
  unit
  quantity
  costMinor
  currency
  jobId
  requestId
  createdAt
```

即使 provider 没返回精确成本，也要能用估算规则生成成本记录。

## 价格和毛利

定价不能只看 provider 成本，还要覆盖：

```text
模型成本
重试成本
失败补偿
存储成本
带宽成本
支付手续费
客服/退款成本
免费额度消耗
营销成本
```

建议每个 capability 有毛利目标：

```text
GrossMarginPolicy
  siteId
  capabilityKey
  targetMarginPercent
  minPriceMicros
  maxSubsidyMicros
```

credit 的 PricingRule 是用户价格，成本记录是平台成本。两者都要按 site/capability 聚合，才能判断一个站点是否赚钱。

## 模型路由

模型选择不是只看质量：

```text
quality
latency
cost
availability
success rate
refund rate
user tier
site policy
```

SiteModelPolicy 需要支持：

```text
default model
fallback group
max cost class
tier requirement
region/provider restriction
```

例子：

```text
music free:
  低成本模型，慢一点可接受。

music pro:
  高质量模型，失败自动 fallback。

white-label enterprise:
  指定 provider account，独立成本归因。
```

## 失败和重试成本

长任务常见：

```text
provider timeout
provider partial failure
safety rejection
asset upload failed
callback lost
```

策略：

```text
用户未得到结果:
  release hold 或 refund。

provider 已产生成本:
  记录 ProviderCostRecord。

平台自动重试:
  job step 记录重试成本。

多次失败:
  降级模型或暂停 capability。
```

这能避免“用户没扣费但平台有成本”完全不可见。

## 免费额度经济性

免费额度不是营销装饰，它是成本预算。

每个站点要有：

```text
FreeQuotaBudget
  siteId
  period
  budgetMinor
  maxFreeUsers
  maxCostPerFreeUser
  allowedCapabilities
```

如果免费额度被滥用：

```text
降低免费模型质量
减少 free bucket
提高验证码/风控
限制同设备/支付工具/手机号
关闭高成本 capability 免费使用
```

## 站点盈利看板

每个 site 至少看：

```text
revenue
provider cost
free quota cost
payment fee estimate
refund amount
gross margin
paid conversion
cost per activation
cost per first successful generation
failed job cost
top losing capability
```

没有这些指标，站点会看起来增长很好但实际亏损。

## 验收标准

- 每个 job 有用户扣费记录和 provider 成本记录。
- 每个 site 能算 capability 毛利。
- 免费额度能按站点预算控制。
- 模型 fallback 不越过站点授权。
- 失败任务的用户结算和平台成本都可追溯。
