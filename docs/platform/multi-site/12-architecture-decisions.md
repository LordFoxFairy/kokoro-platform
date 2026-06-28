# 12 架构决策记录

本文记录多站点 AI 产品工厂的关键决策和取舍。

## ADR-001: siteId 作为第一业务边界

决策：

```text
所有业务数据默认带 siteId。
```

理由：

- 每个站点是独立 AI 产品，不是同一产品的 tab。
- 支持白标、垂直站、独立套餐、独立 SEO。
- 防止用户、积分、订单、产物串站。

代价：

- 所有查询和 API 都要处理 SiteContext。
- 迁移 P0 数据需要 default site。

## ADR-002: 同邮箱跨站默认不同用户

决策：

```text
unique(siteId, emailNormalized)
unique(siteId, provider, providerSubject)
```

理由：

- 邮箱是登录凭证，不是跨产品业务身份。
- 用户在不同站点的意图、套餐、workspace、客服和隐私上下文不同。
- 白标客户不能看到“账号已在其它站存在”的体验。

代价：

- 未来跨站账号绑定要单独实现 AccountLink。
- 风控不能只靠 userId，要聚合 email/device/payment signals。

## ADR-003: 默认不跨站共享积分

决策：

```text
CreditAccount/CreditBucket 默认 site scoped。
```

理由：

- 免费额度、订阅额度、充值包都是站点商业策略。
- 跨站共享会污染转化、毛利和营销预算。

代价：

- 用户可能希望余额通用，后续需要显式 GlobalCreditBundle 产品。

## ADR-004: payment 和 credit 分离

决策：

```text
payment 管商品、订单、订阅、支付事件。
credit 管权益、积分、计价、冻结、扣费、账本。
```

理由：

- 支付成功不等于可以使用所有能力。
- 增量积分包不等于套餐权益。
- 折扣是 pricing 逻辑，不是余额变化。

代价：

- payment 成功后需要可靠调用或事件驱动 credit grant。
- 需要处理 payment succeeded 但 credit grant 失败的异常队列。

## ADR-005: provider/model 平台复用，站点可见性隔离

决策：

```text
ProviderAccount/ModelBinding 可以平台复用。
SiteModelPolicy 控制站点可见模型。
```

理由：

- provider secret 和健康检查不应每站重复维护。
- 不同站点需要不同默认模型、fallback 和成本策略。

代价：

- model resolve 必须始终带 siteId。
- fallback 逻辑不能越过 SiteModelPolicy。

## ADR-006: SEO 作为站点内容资产

决策：

```text
每个 site 独立 sitemap、metadata、canonical、页面矩阵和转化归因。
```

理由：

- 多站点获客需要独立内容角度。
- 只换关键词会造成薄内容和重复内容。
- SEO 页面必须连接到真实 capability 和转化路径。

代价：

- 需要内容治理、页面质量检查和 SEO 运营后台。

## ADR-007: 风控信号可跨站聚合，业务身份不默认合并

决策：

```text
业务 User site scoped。
风险信号可以 platform scoped 聚合。
```

理由：

- 同邮箱跨站独立是产品体验要求。
- 滥用、支付欺诈、免费额度 farming 需要平台级检测。

代价：

- 风控模型和用户模型要分离。
- 后台展示必须避免把风控聚合误解成账号合并。

## ADR-008: 先文档和测试，再大规模 schema 改造

决策：

```text
先固化设计分册和反例测试，再分阶段实现。
```

理由：

- 当前 P0 可运行，不应一次性推翻。
- user/payment/credit/model/session/artifact 都会受影响。
- 先做 kokoro-site 和 SiteContext 能降低后续迁移风险。

代价：

- 短期内文档先于代码，当前代码仍不是最终形态。

## 不做的事

```text
不做全局 email unique。
不做默认跨站钱包。
不让 payment 直接扣费。
不让 model 决定价格。
不让 agent 自己改余额。
不让子服务从 host 猜 site。
不让 SEO 页面只替换关键词。
```
