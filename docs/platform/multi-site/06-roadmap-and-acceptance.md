# 06 分阶段落地路线和验收标准

本文定义多站点 AI 产品工厂的落地顺序。目标是稳步升级，不一次性推翻当前 P0。

## 总体策略

```text
先引入 site 控制面。
再让 user 站点化。
再让 payment/credit 站点化。
再让 model/agent/session/artifact 继承 SiteContext。
最后完善 web/admin/SEO。
```

每一阶段都必须保持：

- 数据可迁移。
- API 可灰度。
- 测试覆盖反例。
- 不恢复 InMemory runtime fallback。
- 不引入中央业务契约子仓。

## P0: 设计固化

已完成/进行中：

```text
docs/platform/multi-site-ai-product-architecture.md
docs/platform/multi-site/*
```

验收：

- 明确 siteId 是第一边界。
- 明确同邮箱跨站默认不同用户。
- 明确所有跨站共享必须显式。

## P1: kokoro-site

交付：

```text
kokoro-site 子仓
Site/SiteDomain/SiteBrand/SiteApp/SitePolicy/SiteSeoConfig schema
host -> SiteContext API
admin manifest
integration tests
docker/k8s service config
```

验收：

- host 可以解析到 SiteContext。
- 未知 host 不允许业务写入。
- site disabled 后写入拒绝。
- runtime config 可被 web/admin 读取。
- 无 InMemory 权威状态。

## P2: kokoro-user 站点化

交付：

```text
User 加 siteId
ExternalIdentity 表
Workspace/Team 加 siteId
Membership/Invite/ServiceAccount/AuditLog 加 siteId
POST /users/ensure 要求 siteId
unique(siteId, emailNormalized)
unique(siteId, provider, providerSubject)
```

迁移：

```text
1. 创建 default site。
2. 现有 user/team 回填 default siteId。
3. 创建 ExternalIdentity 并回填 externalUserId。
4. 增加 site scoped unique。
5. 移除或停用全局 externalUserId unique 依赖。
```

验收：

- 同邮箱在两个 site 创建两个 user。
- 同 OAuth subject 在两个 site 创建两个 user。
- personal workspace 按 site 分别创建。
- site A user 不能访问 site B workspace。

## P3: kokoro-payment 站点化

交付：

```text
PlanTemplate
SiteOffer
Order.siteId
Subscription.siteId
PaymentEvent.siteId
Refund.siteId
provider config 可按 site 覆盖
```

验收：

- music offer 不出现在 video 站。
- music subscription 不影响 video 权益。
- payment event 幂等键包含 siteId。
- site provider config 可独立启用。

## P4: kokoro-credit 站点化

交付：

```text
CreditAccount.siteId
CreditBucket
EntitlementGrant
PricingRule.siteId/appKey/surface/capabilityKey/modelLabel
CreditHold 完整 capture/release
UsageRecord.siteId/jobId/capabilityKey
```

验收：

- free bucket 按 site 隔离。
- topup bucket 默认按 site 隔离。
- 长任务失败 release hold。
- 重试不会重复扣。
- ledger 可追溯 siteId/workspaceId/jobId/capabilityKey。

## P5: kokoro-model 站点可见性

交付：

```text
SiteModelPolicy
model resolve 接收 siteId
provider account 继续平台复用
fallback 不越过 site allowlist
```

验收：

- 未授权模型无法被站点 resolve。
- 站点可以有独立默认模型。
- provider health 可触发站点内 fallback。
- pricing 仍由 credit 管。

## P6: agent/session/artifact 继承 SiteContext

交付：

```text
Conversation.siteId
Message.siteId
AgentRun.siteId
ToolCall.siteId
Job.siteId
Artifact/Project/Asset.siteId
```

验收：

- tool/subagent 不丢 siteId。
- music job 不能写入 video workspace。
- artifact 查询默认 siteId + workspaceId。
- public artifact 只能在所属 site canonical host 下发布。

## P7: web/admin/SEO 产品化

交付：

```text
host -> SiteContext middleware
site theme/i18n/navigation
site sitemap.xml
site robots.txt
site metadata renderer
site admin filter
SEO 页面矩阵
```

验收：

- 每个 host 输出独立 metadata。
- sitemap 不跨站。
- site admin 默认只能看本 site。
- pricing 结构化数据与 SiteOffer 一致。
- SEO 页面不是单纯关键词替换。

## 反例测试清单

每个阶段都要补对应测试：

```text
same email different sites -> different users
same OAuth subject different sites -> different users
site A subscription not visible in site B
site A credit bucket not spendable in site B
site A admin cannot query site B users
site A model policy does not allow site B model
job context cannot switch site mid-run
sitemap contains only current site URLs
```

## 风险清单

```text
R1. 一次性改所有 schema，迁移风险过大。
R2. siteId 只加字段但 API 不强制传，形同虚设。
R3. payment/credit 边界不清，导致扣费绕过账本。
R4. model 可见性和 pricing 混在一起，后期难运营。
R5. SEO 批量页面低质量，影响整站。
R6. 白标后台越权，造成严重数据事故。
R7. 长任务 SiteContext 丢失，产物串站。
```

## 完成定义

多站点架构真正完成，不是文档写完，而是满足：

- 新增一个 AI 产品站点只需配置 site、brand、offer、model policy、seo pages。
- 同一套平台服务可支撑多个独立域名。
- 同邮箱跨站完全独立。
- 任一账本、订单、artifact、job 都可追溯 siteId。
- 白标站默认数据隔离。
- SEO 和套餐可以站点独立运营。
