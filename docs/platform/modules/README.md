# Kokoro Platform 子仓技术方案索引

本文档包用于交接 `kokoro-platform` 下各子仓的技术方案。阅读顺序：

```text
00-overview.md
  平台子仓共性约束、数据库选型、部署和验证策略。

01-kokoro-site.md
  站点、域名、应用开关、策略、品牌、SEO 的权威模块。

02-kokoro-user.md
  站点内用户、团队、成员、角色、服务账号和审计模块。

03-kokoro-model.md
  模型配置、provider account、model binding、label、LiteLLM/直连分流模块。

04-kokoro-credit.md
  积分账户、冻结、账本、usage、pricing rule、套餐权益结算模块。

05-kokoro-payment.md
  plan、order、subscription、payment event、provider webhook 模块。

06-kokoro-litellm.md
  LiteLLM 网关集成边界，不复制网关实现。

07-kokoro-platform-kit.md
  无业务状态的公共基础工具包边界。
```

总原则：

```text
siteId 是第一业务隔离边界。
核心管理数据用 MySQL。
产物和任务结果后续用 Mongo。
当前方案不引入 PostgreSQL。
每个子仓自己拥有 schema、API、admin manifest、部署入口和测试。
```
