# kokoro-platform

Kokoro 平台域父仓库。它不是单个业务模块，而是平台能力的主控层：登记平台模块、统一本地运行、统一验证、约束模块边界，并把各子仓的后台入口和内部调用面挂起来。

## 数据库迁移状态（必须先读）

当前存在两个**有明确先后关系、不能混称为双真源**的阶段：

- 现行 legacy 模块仍通过各自 Prisma 6 schema、MySQL database 和独立 HTTP process 工作；现有
  `pnpm db:migrate`、integration CI 与回滚基线继续服务这一阶段。
- 根目录 Prisma 7/PostgreSQL 18 是 Wave 1 的 `transition-candidate`。它当前只包含 foundation marker、
  PG18/数据库/角色/ACL preflight、migration advisory lock，以及 API/Worker/Migrator 的 health/bootstrap
  deployable。`activationAuthorized=false`、`runtimeTraffic=false`，尚未承载 Site、Identity、Model、Credit、
  Payment、Hub 或 Admin 业务事实。
- `platform-api`、`platform-worker` 与 `platform-migrator` 使用三个互异数据库角色。Task 3 阶段 API/Worker
  只能读取 foundation marker；后续业务表权限必须随 owner migration 精确授予，不能使用全表 DML 默认权限。
- 只有 Root 管理的 PostgreSQL component、兼容、备份恢复和切换证据全部通过后，Task 19 才能移除 legacy
  MySQL 写面并把 candidate 晋升为唯一 Platform authority。

因此，本仓当前的 PostgreSQL 代码是可构建、可部署但不接业务流量的候选基础，不代表 Platform 业务模块已经迁移完成。

## 当前形态

```text
kokoro-platform
  src/                         平台模块注册表和主控约束
  test/                        平台注册表测试
  kokoro-platform-kit/         非业务技术工具包：HTTP envelope、healthz、启动器、admin manifest schema
  kokoro-site/                 站点、域名、应用开关、策略、品牌和 SEO 配置
  kokoro-user/                 用户、团队、成员、角色、服务账号
  kokoro-model/                模型配置、provider account、模型标签和兜底策略
  kokoro-credit/               积分账户、扣减、账本、计价规则
  kokoro-payment/              套餐、订单、支付事件、支付 provider 配置
```

Legacy 当前阶段的存储形态如下；它是过渡基线，不是 Wave 1 最终目标：

```text
MySQL + Prisma:
  一个本地库 kokoro。
  用户、团队、权限、模型配置、支付、积分、账本、后台管理状态。
  每个子仓自己维护 Prisma schema 和 migration，表名按领域隔离。

MongoDB，后置:
  artifact 文档、生成结果结构、草稿、版本正文、provider raw output、agent trace。

对象存储，后置:
  音频、视频、图片、导出文件和附件。
```

## 第一轮范围

当前激活并可独立运行的模块：

```text
kokoro-site
kokoro-user
kokoro-model
kokoro-credit
kokoro-payment
```

核心业务链路已实现（具体能力见各模块章节与 `docs/platform/subrepo-capability-roadmap.md`）：

```text
credit   账户(balance/held)、grant/spend(可用额原子扣减)、quote/hold/capture/release，全幂等并发安全
model    provider/binding upsert、/model-bindings/resolve（排除 down/disabled，priority 有序候选）
payment  redeem-only：Site 套餐目录与历史只读管理；购买/确认/退款/webhook 统一 fail-closed
site     site/domain/app/policy upsert、resolveSiteContext（host 规范化、未 active 返回 null）
user     ensureUserWithPersonalTeam、listTeamsForUser
```

仍需产品决策的边界（hold 过期回收、refund 回链、PaymentEvent/webhook 驱动、Subscription、ModelLabel 解析、team/邀请/权限、品牌/SEO 投影等）见 `docs/platform/2026-06-29-audit-and-known-boundaries.md`。

这些 legacy 模块目前仍持有 Prisma schema、migration、service、repository、HTTP/internal API、admin manifest
和 `.env.example`。根 PostgreSQL migration 从 foundation 开始，后续按 owner module 迁入；禁止通过本地 self-RPC
模拟同一 Platform bounded context。

LiteLLM、支付宝、微信支付、Stripe、Paddle、Strapi 等第三方能力不在平台内从 0 复刻。平台只保存自己的配置、映射、事件、审计和嵌入策略；能 OAuth 或 iframe/admin link 接入的，优先接入成熟系统。

## 核心设计文档

顶层文档入口见 [docs/README.md](docs/README.md)。平台仓 docs 可以记录 platform
父仓和平台模块自己的长期方案；跨仓总规则仍归根仓 `../docs/kokoro-handbook/`。

```text
docs/platform/subrepo-capability-roadmap.md
  平台子仓职责、DDD 边界、当前能力和后续补齐顺序。

docs/platform/deployment-topology.md
  Docker/Kubernetes、稳定服务名、多 Pod 运行约束。

docs/platform/multi-site-ai-product-architecture.md
  多站点 AI 产品工厂设计：siteId 隔离、同邮箱跨站独立账号、套餐/积分/模型/SEO 站点化。

docs/platform/multi-site/
  多站点设计分册，细化 site、user、payment、credit、model、agent、web、SEO 和落地路线。
```

## 平台根职责

平台根只做这些事：

```text
模块注册表:
  src/platform-registry.ts 维护 site/user/model/credit/payment/litellm 的状态、存储、后台入口、运行面和边界。

统一命令:
  pnpm test:repository
  pnpm test
  pnpm test:integration
  pnpm typecheck
  pnpm lint

本地基础设施:
  docker-compose.yml 只启动本地 MySQL，并创建 kokoro database。

PostgreSQL transition candidate:
  prisma/                         单一 Platform PostgreSQL schema/migration owner
  src/infrastructure/postgres/    受限 client、PG18/role/ACL preflight、migrator
  src/process/                    candidate API/Worker health 与 drain bootstrap
  deployables.yaml                activationAuthorized=false 的制品角色清单
```

平台根不做这些事：

```text
不保存各模块 env 示例。
除单一 Platform Prisma migration 外，不保存旁路业务建库 SQL。
不定义中央业务契约子仓。
不替代各模块自己的 Prisma schema、迁移、API、admin manifest。
不直接修改 credit/payment/model/user 的业务数据。
```

## 环境变量

每个子仓自己管理 `.env.example`：

```text
kokoro-site/.env.example
kokoro-user/.env.example
kokoro-model/.env.example
kokoro-credit/.env.example
kokoro-payment/.env.example
kokoro-litellm/.env.example
```

平台根不保留 `.env.example`，避免把不同模块的运行配置揉在一起。

## 本地开发

```bash
pnpm install
pnpm dev:db
pnpm db:migrate
pnpm build:runtime
# 仅在 Root 签发候选角色与数据库 lease 后：
pnpm db:migrate:platform
pnpm db:generate
pnpm test
pnpm test:integration
pnpm typecheck
```

平台服务不提供运行时 InMemory fallback。Legacy integration 仍连接真实 MySQL；PostgreSQL component test 必须
连接 Root 签发的 PG18 leased database/roles，不得私启第二套 Compose。

本地 `.env.example` 默认使用 `mysql://root:kokoro_root@127.0.0.1:3307/kokoro`，这样 Prisma `migrate dev` 可以创建 shadow database。生产环境必须替换为受限账号。生产可以继续单库，也可以在规模变大后拆库；拆库是部署拓扑变化，不应该改变模块内部领域边界。

注意：共享单库 `kokoro` 上只跑 `pnpm db:migrate`。不要在平台根对共享库跑 `pnpm -r db:dev`，Prisma 会把其它子仓的表识别为 drift。需要为某个子仓生成新 migration 时，用该子仓自己的临时 scratch database 生成，再通过 `pnpm db:migrate` 部署到共享库。

## 部署拓扑

平台服务用稳定服务名互相发现，Docker Compose 和 Kubernetes 都不要求业务代码改地址：

```text
KOKORO_USER_BASE_URL=http://kokoro-user:4211
KOKORO_MODEL_BASE_URL=http://kokoro-model:4221
KOKORO_CREDIT_BASE_URL=http://kokoro-credit:4231
KOKORO_PAYMENT_BASE_URL=http://kokoro-payment:4241
```

本地连同四个平台服务一起启动：

```bash
docker compose -f docker-compose.yml -f deploy/docker-compose.services.yml up --build
```

Kubernetes 样例：

```bash
kubectl apply -f deploy/k8s/platform-services.example.yaml
```

`deploy/k8s/platform-services.example.yaml` 只作为部署模板。生产环境的 Secret、Ingress、HPA、镜像 tag、资源限额应该由环境仓或 GitOps 仓维护。

详细约束见 [docs/platform/deployment-topology.md](docs/platform/deployment-topology.md)。

仓库 CI 在 lint、typecheck、unit 和独立 integration gate 通过后，使用
`deploy/docker/Dockerfile` 构建以 commit SHA 标记的 Platform deployment image，确保子仓自己的
lock、源码和部署入口能够独立产出 artifact。镜像发布与环境提升仍由受管 release 流程负责。
