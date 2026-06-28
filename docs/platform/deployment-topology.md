# Kokoro Platform 部署拓扑

本文约束 `kokoro-platform` 下平台子仓的 Docker、Kubernetes 和服务间调用方式。目标是让 `kokoro-site`、`kokoro-user`、`kokoro-model`、`kokoro-credit`、`kokoro-payment` 都可以独立扩容，同时不因为从 Docker Compose 切到 Kubernetes 就改业务代码。

## 核心判断

平台服务按“独立进程、稳定服务名、共享基础设施”部署：

```text
kokoro-web / admin / gateway
  -> kokoro-site
  -> kokoro-user
  -> kokoro-model
  -> kokoro-credit
  -> kokoro-payment

kokoro-site/user/model/credit/payment
  -> MySQL kokoro
  -> Redis，后置
  -> object storage，后置
  -> third-party providers，后置
```

根仓只提供编排样例和质量约束。每个业务子仓仍然自己拥有 `.env.example`、Prisma schema、migration、HTTP entry、admin manifest、测试和 README。

## 服务名约定

代码和配置不要写死 Pod IP，也不要把内部服务调用写成 `localhost`。

Docker Compose 使用 service name：

```text
http://kokoro-site:4201
http://kokoro-user:4211
http://kokoro-model:4221
http://kokoro-credit:4231
http://kokoro-payment:4241
```

Kubernetes 使用 Service DNS。默认同 namespace 时也使用同样短名：

```text
http://kokoro-site:4201
http://kokoro-user:4211
http://kokoro-model:4221
http://kokoro-credit:4231
http://kokoro-payment:4241
```

跨 namespace 时由部署层覆盖为完整 DNS：

```text
http://kokoro-user.kokoro-platform.svc.cluster.local:4211
```

统一环境变量：

```text
KOKORO_SITE_BASE_URL
KOKORO_USER_BASE_URL
KOKORO_MODEL_BASE_URL
KOKORO_CREDIT_BASE_URL
KOKORO_PAYMENT_BASE_URL
```

这些变量是后续 agent、session、admin、payment webhook worker 等模块调用平台能力的稳定入口。业务代码只读取 base URL，不判断自己运行在 Docker 还是 Kubernetes。

## Docker Compose

本地基础设施仍由根 `docker-compose.yml` 提供 MySQL。平台服务由覆盖文件提供：

```bash
docker compose -f docker-compose.yml -f deploy/docker-compose.services.yml up --build
```

这个命令会启动：

```text
mysql
kokoro-site
kokoro-user
kokoro-model
kokoro-credit
kokoro-payment
```

第一阶段镜像使用 workspace 依赖和 `tsx` 入口启动，保证和当前 TypeScript 源码结构一致。后续如果要压缩镜像体积，再切为 `tsc` build + `node dist`，但不能牺牲子仓自治和 package exports 的清晰度。

## Kubernetes

`deploy/k8s/platform-services.example.yaml` 是部署样例，不是生产机密文件。生产 Secret、Ingress、HPA、镜像 tag 和资源限额由环境仓或 GitOps 仓维护。

默认形态：

```text
Deployment/kokoro-site replicas=2
Service/kokoro-site ClusterIP

Deployment/kokoro-user replicas=2
Service/kokoro-user ClusterIP

Deployment/kokoro-model replicas=2
Service/kokoro-model ClusterIP

Deployment/kokoro-credit replicas=2
Service/kokoro-credit ClusterIP

Deployment/kokoro-payment replicas=2
Service/kokoro-payment ClusterIP
```

内部平台服务默认不直接暴露公网。公网入口后续放在 `kokoro-web`、admin、API gateway 或 ingress 层。

## 多 Pod 约束

所有平台服务必须满足：

- 无运行时 InMemory fallback。
- 不把 session、锁、余额、幂等状态、任务状态放在进程内存。
- HTTP 服务监听 `0.0.0.0`。
- 暴露 `/healthz`，供 readiness/liveness probe 使用。
- 关闭进程时先停止接收请求，再关闭 Prisma 连接。
- 数据一致性依赖 MySQL 事务、唯一索引和幂等 key。
- 后续需要异步任务时，使用队列和数据库状态机，不用单进程定时器承载关键状态。

模块侧重点：

```text
kokoro-site:
  Site、SiteDomain、SiteApp、SitePolicy、Brand/SEO 配置在 MySQL。
  业务子仓消费 siteId，不直接从 host 推断站点。

kokoro-user:
  user/team/membership/service account 权威状态在 MySQL。

kokoro-model:
  provider account、binding、label、health status 在 MySQL。
  provider secret 只保存 secretRef。

kokoro-credit:
  余额、冻结、账本、usage、pricing rule 在 MySQL。
  spend/grant 必须有幂等 key 和 ledger entry。

kokoro-payment:
  plan/order/payment event/provider config/idempotency 在 MySQL。
  支付 provider 的 webhook 必须按 provider event id 幂等处理。
```

## 数据库

第一阶段使用一个 MySQL database：`kokoro`。

```text
DATABASE_URL_SITE
DATABASE_URL_USER
DATABASE_URL_MODEL
DATABASE_URL_CREDIT
DATABASE_URL_PAYMENT
```

四个 env 可以指向同一个库，也可以在未来部署层拆成不同库。拆库不能改变模块的领域边界。

生产环境不要使用 root 账号。每个模块可以使用受限数据库账号，但表结构仍由各自 Prisma migration 管理。

数据库组合：

- MySQL：平台核心管理数据，包括 site、user、model、credit、payment。
- Mongo：后续用于 artifact、job result、创作产物、非结构化上下文等产物型数据。
- PostgreSQL：当前方案不引入，避免数据库组合过重。

## 边界红线

- 平台根不持有业务 `.env.example`。
- 平台根不写业务建库 SQL。
- 不新增中央业务契约子仓。
- 不新增 `ports` 目录命名。
- 不跨子仓直接读写对方表。
- 不在服务间调用里写 `localhost`。
- 不把支付网关、LiteLLM、Strapi 这类成熟系统从 0 复制一遍。

## 质量门禁

每次修改平台部署或子仓公共能力后至少运行：

```bash
pnpm run test:platform
pnpm typecheck
pnpm test
pnpm lint
docker compose -f docker-compose.yml -f deploy/docker-compose.services.yml config
```

涉及 Prisma schema、repository 或 HTTP API 时，继续运行：

```bash
pnpm test:integration
```
