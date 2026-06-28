# kokoro-site

`kokoro-site` 是 Kokoro 多站点 AI 产品工厂的站点权威模块。

它只负责站点事实和入口上下文：

- `Site`
- `SiteDomain`
- `SiteApp`
- `SitePolicy`
- `SiteBrandConfig`
- `SiteSeoConfig`

它不负责用户、积分、支付、模型 provider、agent session 或生成产物。

## 边界

```text
owns:
  domain -> site 的解析权威
  site/app/policy/brand/seo 的管理权威
  SiteContext 的源数据

does not own:
  users
  teams/workspaces
  credit ledger
  payment orders
  model provider secrets
  agent jobs
  artifacts
```

业务子仓消费 `siteId`，不直接解析域名。
