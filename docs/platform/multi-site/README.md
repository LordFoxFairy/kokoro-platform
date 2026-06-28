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

07-site-lifecycle-and-operating-model.md
  站点生命周期、上线清单、运营对象、下线策略。

08-data-governance-security-risk.md
  数据分类、访问边界、审计、安全、风控和删除保留。

09-ai-capability-economics.md
  AI 能力目录、成本、毛利、模型路由、免费额度经济性。

10-seo-content-operations.md
  SEO 内容生产、页面质量、站点增长归因。

11-admin-observability-governance.md
  后台分层、指标体系、可观测性、异常和配置治理。

12-architecture-decisions.md
  关键架构决策和取舍。
```

最重要的原则：

```text
siteId 是第一业务隔离边界。
同邮箱跨站注册默认是不同用户。
所有跨站共享都必须显式设计。
```
