# kokoro-platform

Kokoro 平台域父仓库。它不是单个业务模块，而是平台能力的主控层：登记平台模块、统一本地运行、统一验证、约束模块边界，并把各子仓的后台入口和内部调用面挂起来。

## 当前形态

```text
kokoro-platform
  src/                         平台模块注册表和主控约束
  test/                        平台注册表测试
  kokoro-platform-kit/         非业务技术工具包：HTTP envelope、healthz、启动器、admin manifest schema
  kokoro-user/                 用户、团队、成员、角色、服务账号
  kokoro-model/                模型配置、provider account、模型标签和兜底策略
  kokoro-credit/               积分账户、扣减、账本、计价规则
  kokoro-payment/              套餐、订单、支付事件、支付 provider 配置
```

第一阶段先实现平台管理核心，不做产物系统。存储策略保持清晰：

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
kokoro-user
kokoro-model
kokoro-credit
kokoro-payment
```

这些模块都必须自己持有 Prisma schema、migration、service、repository、HTTP/internal API、admin manifest 和 `.env.example`。平台根不写 InMemory fallback，也不保存各模块的业务建库 SQL。早期统一连接一个 MySQL database：`kokoro`，通过模块目录和表名隔离复杂度。

LiteLLM、支付宝、微信支付、Stripe、Paddle、Strapi 等第三方能力不在平台内从 0 复刻。平台只保存自己的配置、映射、事件、审计和嵌入策略；能 OAuth 或 iframe/admin link 接入的，优先接入成熟系统。

## 核心设计文档

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
  src/platform-registry.ts 维护 user/model/credit/payment/litellm 的状态、存储、后台入口、运行面和边界。

统一命令:
  pnpm test
  pnpm test:integration
  pnpm typecheck
  pnpm lint

本地基础设施:
  docker-compose.yml 只启动本地 MySQL，并创建 kokoro database。
```

平台根不做这些事：

```text
不保存各模块 env 示例。
不保存业务建库 init SQL。
不定义中央业务契约子仓。
不替代各模块自己的 Prisma schema、迁移、API、admin manifest。
不直接修改 credit/payment/model/user 的业务数据。
```

## 环境变量

每个子仓自己管理 `.env.example`：

```text
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
pnpm db:generate
pnpm test
pnpm test:integration
pnpm typecheck
```

平台服务不提供运行时 InMemory fallback。本地和集成测试都应该连接真实数据库。

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
