# Kokoro Platform 子仓总技术方案

## 目标

`kokoro-platform` 不是一个大业务服务，而是平台子仓集合的管理仓库。它负责统一注册、部署样例、质量门禁和文档；具体业务权威由各子仓负责。

## 子仓列表

```text
kokoro-site
  站点、域名、应用开关、策略、品牌、SEO。

kokoro-user
  用户、团队、成员、角色、邀请、服务账号、审计。

kokoro-model
  provider account、model binding、model label、模型可见性和兜底。

kokoro-credit
  积分账户、冻结、账本、usage、pricing rule、权益和扣费。

kokoro-payment
  plan、order、subscription、payment event、refund。

kokoro-litellm
  LiteLLM 网关配置和部署接入。

kokoro-platform-kit
  response、amount、admin manifest schema、HTTP server 等无业务状态工具。
```

## 架构层次

每个业务子仓统一四层：

```text
src/domain
  实体、值对象、领域错误、repository interface。

src/application
  用例编排，只依赖 domain。

src/infrastructure
  Prisma、第三方 SDK、provider adapter。

src/interfaces
  HTTP、admin manifest、未来 worker/RPC adapter。

src/config
  env schema 和配置解析。
```

红线：

- 不建 `kokoro-contracts`。
- 不使用 `ports` 目录命名。
- 不跨子仓直接读写对方表。
- 不把业务逻辑塞进 `kokoro-platform`。
- 不把业务逻辑塞进 `kokoro-platform-kit`。

## 数据库

当前数据库组合：

```text
MySQL:
  site/user/model/credit/payment 等核心管理和账务数据。

Mongo:
  后续 artifact、job result、创作内容、非结构化上下文、大 JSON 状态。

PostgreSQL:
  当前方案不引入，避免 MySQL/Mongo/PG 三套数据库同时维护。
```

MySQL 早期可以共用一个 database：`kokoro`。每个子仓仍然拥有自己的 Prisma schema、migration 和表名前缀。后续拆库只能是部署拓扑变化，不改变领域边界。

## 服务调用

Docker Compose 和 Kubernetes 都使用稳定服务名：

```text
http://kokoro-site:4201
http://kokoro-user:4211
http://kokoro-model:4221
http://kokoro-credit:4231
http://kokoro-payment:4241
```

环境变量：

```text
KOKORO_SITE_BASE_URL
KOKORO_USER_BASE_URL
KOKORO_MODEL_BASE_URL
KOKORO_CREDIT_BASE_URL
KOKORO_PAYMENT_BASE_URL
```

业务代码不能写死 `localhost`。

## SiteContext

入口层通过 `kokoro-site` 把 host/domain 解析为站点上下文：

```text
host -> siteId/siteKey/appKey/surface/defaultLocale/timezone
```

业务子仓只消费 `siteId`，不自己解析 host。

## 管理后台

每个子仓提供：

- admin manifest
- 管理 API
- permission key
- resource/action 声明

`kokoro-web/admin` 统一渲染后台壳子、导航、列表、表单、详情、审计页。复杂模块允许自定义页面 adapter。

## 质量门禁

每次改平台子仓至少运行：

```bash
pnpm typecheck
pnpm test
pnpm lint
docker compose -f docker-compose.yml -f deploy/docker-compose.services.yml config
```

涉及 Prisma schema、repository 或 HTTP API 时继续运行：

```bash
pnpm test:integration
```
