# 多站点 AI 产品工厂设计包

本目录是 `docs/platform/multi-site-ai-product-architecture.md` 的细化分册。

阅读顺序：

```text
00-principles-and-invariants.md
  不可变原则、反例和验收基线。

01-site-control-plane.md
  kokoro-site 站点控制面。

02-user-workspace-identity.md
  kokoro-user 站点化、同邮箱跨站独立账号、workspace 和权限。

03-payment-credit-billing.md
  payment/credit 站点化、套餐、offer、积分包、权益、定价、扣费闭环。

04-model-agent-session-artifact.md
  model 站点可见性、agent/session/job/artifact SiteContext 继承。

05-web-admin-seo.md
  多站点 web/admin/SEO、站点内容矩阵、canonical/sitemap/结构化数据。

06-roadmap-and-acceptance.md
  分阶段落地路线、反例测试、风险和完成定义。
```

最重要的原则：

```text
siteId 是第一业务隔离边界。
同邮箱跨站注册默认是不同用户。
所有跨站共享都必须显式设计。
```
