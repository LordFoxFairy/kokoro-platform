# 成熟件优先 / 可控 路线图

原则：**能用成熟的就用成熟的，绝不手搓轮子**；一律选**自托管开源**（不上 SaaS 黑盒），保持完全可控 + 细粒度。

## 已用成熟件（底座）

Prisma(ORM/迁移) · Zod(校验) · Fastify(HTTP) · @fastify/swagger + swagger-ui(OpenAPI) · pnpm。

## 该换成熟件的（手搓→成熟）

| 现状(手搓) | 成熟替代(自托管) | 状态 |
|---|---|---|
| operator 认证(dev header 占位) | **OIDC + Keycloak**（IdP）；网关 **@fastify/jwt + JWKS(get-jwks)** 验 token | ← 本轮落地。认证永不手搓 |
| 运营台 UI(vanilla HTML) | **React-Admin**（自定义页放用户360；数据源对接现有网关 API） | 待办。最大的轮子 |
| RBAC(permits glob + scopeSites) | **Casbin**（node-casbin，RBAC-with-domains 原生多租户；policy-as-code） | 可选。现状能用且测过 |

## 保留自研（成熟件过重）

审计表(append-only) · 审批 maker-checker(领域逻辑，Temporal 过重) · 跨服务 saga 补偿(领域特定)。

## 认证设计（本轮）

- **模式** `KOKORO_ADMIN_AUTH_MODE`：`oidc`(生产，验 JWT) | `dev`(本地，沿用 x-kokoro-operator 头)。默认 oidc。
- **oidc**：请求带 `Authorization: Bearer <JWT>`；网关用 @fastify/jwt + get-jwks 拉 IdP 的 JWKS 验签（RS256，自动轮换 key）；校验 `iss`/`aud`；operator email 从可配 claim(默认 `email`)取 → 既有 `resolveOperator` 按 email 查 operator（身份认证归 IdP，授权/角色/租户作用域仍归我们 RBAC，职责清晰）。
- **dev**：无 IdP 时本地仍可用，x-kokoro-operator 头（仅 dev）。
- **可控**：IdP 自托管 Keycloak（realm/用户/登录策略全在你手里）；网关只验签，不存密码、不发 token。
