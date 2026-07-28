# Kokoro Platform 技术栈标准

统一、可控、自托管优先、用成熟件不造轮子。本标准覆盖 **kokoro-platform**（5 业务服务 + 运营台）。运行时 agent 是 Python（另一域），见末尾边界。

## 语言 / 工程

- **TypeScript** 全栈（strict、NodeNext ESM、exactOptionalPropertyTypes、noUncheckedIndexedAccess）。零 `any`/`cast`（框架边界用 `Any`/jsonValue 洗）。
- **pnpm** workspace monorepo。
- **Vitest**（单元 + 集成）；**Playwright**（前端 E2E）。
- **ESLint**（+ Prettier 可选）。dev 用 `tsx`，门禁 `tsc --noEmit`。

## 后端服务（site / user / model / credit / payment / admin 网关）

- **Fastify 5**（HTTP）。
- **Prisma 6 + MySQL**（ORM/迁移；钱/积分一律 `$transaction` + 幂等 + 原子条件更新）。
- **Zod**（外部载荷一律 `.strict()` 洗净）。
- **@fastify/swagger**（JSON-only OpenAPI `/docs/json`；body schema 走 kit `jsonSchema`，已做 AJV 兼容；生产不暴露 Swagger UI/static/YAML）。
- 跨服务：HTTP + `RequestContext` 头（`x-kokoro-site-id/request-id/principal`）；契约 codegen（root `contract/events.yaml`）。
- 共享底座：`@kokoro/platform-kit`（responses / amount / RequestContext / manifest / openapi）。

## 运营台前端

- **Next.js**（App Router）+ React + TypeScript。
- **认证 = Auth.js**（库，非托管；email magic-link 内置；零外部 IdP）。登录拿 JWT → 调网关 → 网关 **jose** 验签取 email → 现有 RBAC。
- **UI 组件 = shadcn/ui**（Radix + Tailwind；组件代码进我们仓、完全可控）——不要重型黑盒 UI 库，也不用 React-Admin 那种强约定 CRUD（运营台是定制工作台：用户360/审批/权限/审计 各页自建）。
- 数据源：对接现有网关 API（`/api/*`）。

## 认证 / 授权 / 安全

- **认证**（你是谁）：Auth.js（自家 Next.js，email 登录）。
- **授权**（能做什么 × 哪个租户 × 看哪些功能）：自研 RBAC（`permits` glob + `scopeSites` 租户作用域 + manifest requiredPermission 过滤）。可选迁 **Casbin**（RBAC-with-domains）。
- **JWT/crypto**：**jose**（成熟，零手搓加密）。
- **审计**：自研 append-only `audit_logs`（网关守门人记，含 actor/前后/理由/result）。
- **审批**：自研 maker-checker（`ApprovalRequest` + 原子转移防重复执行）。

## 明确不引入

外部托管 IdP / auth 产品（Keycloak / Auth0 / Logto / Clerk）；重型企业中间件；SaaS 黑盒。**能自托管/进自己仓的就自己掌控。**

## 部署 / 配置

- docker compose / k8s；服务地址走 `KOKORO_*_BASE_URL` 服务名 env（**禁止硬编码 localhost**，本地经 env 覆盖）。
- 每服务独立 MySQL 库（kokoro_site/user/model/credit/payment/admin）。

## 双栈边界（非本域，不在此标准强制）

- **运行时 agent**（kokoro-agent）：**Python**（Pydantic V2 strict、uv、pytest）——另一 agent 域。
- **运行时 web**（kokoro-web）：TS——另一 agent 域，框架由其定。
- 平台↔运行时只经 **contract（events.yaml）** 对齐，不互相约束内部栈。
