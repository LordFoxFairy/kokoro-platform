# 00 多站点 AI 产品工厂原则

本文定义后续所有子仓必须遵守的不可变原则。它优先级高于具体表结构和当前 P0 实现。

## 产品判断

Kokoro 不是单一 SaaS 加多个入口，而是一套 AI 产品工厂：

```text
一个平台内核
多个独立 AI 产品站点
站点体验、账号、套餐、积分、SEO 默认互不影响
底层模型、支付、积分引擎、agent、后台能力复用
```

每个站点都应该像新产品：

```text
独立域名
独立品牌
独立注册
独立 workspace
独立套餐
独立免费额度
独立积分包
独立 SEO 内容资产
独立后台运营视角
```

## 不可变原则

```text
P1. siteId 是第一业务隔离边界。
P2. 同邮箱跨站注册默认是不同 User。
P3. workspace/team 默认按 siteId 隔离。
P4. payment order/subscription 默认按 siteId 隔离。
P5. credit account/bucket/ledger 默认按 siteId 隔离。
P6. agent/session/job/artifact 默认按 siteId 隔离。
P7. provider account/model adapter 可以平台复用，但站点可见性必须显式配置。
P8. 跨站共享只能作为显式产品能力，不能默认发生。
P9. 子服务不能从 host 猜站点，只能消费入口解析出的 SiteContext。
P10. 后台默认按 siteId 过滤，只有 platform super admin 可以跨站。
```

## 为什么同邮箱不能全局合并

邮箱是登录凭证，不是跨产品业务身份。同一个邮箱在不同站点可能代表不同使用意图、不同团队、不同购买关系和不同隐私上下文。

反例：

```text
music.example.com:
  a@example.com 注册并领取 100 免费积分。

video.example.com:
  a@example.com 再注册并领取视频站免费额度。

如果按邮箱全局合并:
  免费额度、套餐、风控、客服、workspace 都可能串。
```

正确行为：

```text
unique(siteId, emailNormalized)
unique(siteId, provider, providerSubject)
```

必要时后续可以做显式跨站绑定：

```text
AccountLink
CrossSiteOrganization
GlobalCreditBundle
```

但这些都不是默认行为。

## 数据隔离默认值

```text
User                 site scoped
ExternalIdentity     site scoped
Workspace/Team       site scoped
Membership           site scoped
Invite               site scoped
ServiceAccount       site scoped
Order                site scoped
Subscription         site scoped
PaymentEvent         site scoped
CreditAccount        site scoped
CreditBucket         site scoped
CreditLedgerEntry    site scoped
PricingRule          site scoped, 可有 platform fallback
EntitlementGrant     site scoped
ModelProvider        platform scoped
ModelBinding         platform scoped
SiteModelPolicy      site scoped
Conversation         site scoped
Job/Run              site scoped
Artifact/Project     site scoped
SEO Route            site scoped
```

## 统一上下文

所有业务写入请求必须携带：

```text
siteId
siteKey
appKey
surface
requestId
```

认证后补齐：

```text
userId
workspaceId
membershipRole
```

长任务继续继承：

```text
jobId
capabilityKey
modelLabel
idempotencyKey
```

## 反例校验

设计、代码和测试必须能挡住这些场景：

```text
同邮箱跨站:
  music 和 video 创建不同 User。

套餐跨站:
  music Pro 不给 video Pro 权益。

免费额度跨站:
  music 免费额度不能在 video 扣。

积分包跨站:
  music topup 默认不能在 image 扣。

白标隔离:
  brand A 后台看不到 brand B 用户、订单、artifact。

模型可见性:
  music 站看不到只给 video 站开的模型。

SEO 重复:
  两个站点相似页面必须有不同内容角度或 canonical 策略。

agent 任务:
  music job 不能写入 zeze workspace。
```

## 子仓责任边界

```text
kokoro-site:
  定义站点和 SiteContext。

kokoro-user:
  定义站点内用户、workspace、权限。

kokoro-payment:
  定义站点内 offer、订单、订阅。

kokoro-credit:
  定义站点内钱包、bucket、权益、计价、扣费。

kokoro-model:
  定义平台模型和站点可见性。

kokoro-agent/session:
  在 SiteContext 中执行任务，不拥有计费和身份权威。

kokoro-web/admin:
  根据 host 解析站点，渲染多站点体验和 SEO。
```

## 自我评估标准

一个设计只有同时满足下面条件才算合格：

- 新增站点不需要复制一套后端服务。
- 新增站点不会继承其它站点用户、套餐、余额。
- 同一模型 provider 可以服务多个站点。
- 每笔订单、扣费、artifact 都能追溯到 siteId。
- site admin 默认无法越权看其它站点。
- SEO 页面能独立运营，不只是换关键词。
- 后续白标、垂直站、studio 站都能套用同一模型。
