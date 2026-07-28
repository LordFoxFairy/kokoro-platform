# 成熟件优先 / 可控 路线图

原则：**能用成熟的就用成熟的，绝不手搓轮子**；一律选**自托管开源**（不上 SaaS 黑盒），保持完全可控 + 细粒度。

## 已用成熟件（底座）

Prisma(ORM/迁移) · Zod(校验) · Fastify(HTTP) · @fastify/swagger(JSON-only OpenAPI contract) · pnpm。

## 该换成熟件的（手搓→成熟）

| 现状(手搓) | 成熟替代(自托管) | 状态 |
|---|---|---|
| operator 认证 + 运营台 UI | **Next.js + Auth.js**（Auth.js 是库非托管服务,email magic-link 内置,零外部 IdP）；网关 jose 验 Auth.js 签发的 JWT(seam 不变) | 认证与 UI 框架是同一件事,合并做 |
| RBAC(permits glob + scopeSites) | **Casbin**（node-casbin，RBAC-with-domains 原生多租户；policy-as-code） | 可选。现状能用且测过 |

## 保留自研（成熟件过重）

审计表(append-only) · 审批 maker-checker(领域逻辑，Temporal 过重) · 跨服务 saga 补偿(领域特定)。

## 认证设计（定稿：Auth.js，零外部托管）

- **Auth.js 是库不是服务**：跑在我们自己的 Next.js 运营台里，登录流程/会话/email 发送全在自己代码掌控，**不依赖任何外部 IdP/托管产品**。email magic-link(+可选社交登录)是其成熟内置。
- **与 UI 框架合并做**：运营台 UI 从 vanilla HTML 迁到 **Next.js**，Auth.js 同时落地——认证与 UI 框架本就是一件事。
- **网关职责不变(seam 留用)**：Next.js 运营台经 Auth.js 登录拿到会话/JWT；调网关 API 时带上；网关用 **jose** 验签取 operator email → 既有 `resolveOperator` + RBAC(角色/租户作用域)。身份归 Auth.js，授权归我们，职责分离。
- **dev**：本地仍可 `KOKORO_ADMIN_AUTH_MODE=dev`（x-kokoro-operator 头）跑后端，不必起前端。
- 当前网关已落地 jose 验签 + dev 模式；接 Auth.js 时只需把「验外部 JWKS」调成「验 Auth.js 签发的 JWT」(同一 jose 路径，小改)。
