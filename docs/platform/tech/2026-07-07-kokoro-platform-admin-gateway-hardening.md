# kokoro-platform-admin 网关与运营治理完善技术方案

> 状态：方案锁定稿。本文只覆盖 `kokoro-platform-admin`，把当前已有 auth/gateway/approval/RBAC 半成品纳入收束范围；不展开 `kokoro-admin-web`、业务子仓或 platform-kit。

## 1. 为什么现在做 platform-admin

业务子仓已经补齐核心 create/upsert/delete/restore 合约，`kokoro-platform-kit` 也完成横切工具收束。下一层风险在运营后台网关：运营界面可以做可见性过滤，但真正可靠的方式必须由 `platform-admin` 在服务端重新执行认证、RBAC、租户作用域、审批和审计。

选择本轮聚焦 platform-admin 的理由：

- 它是 admin-web/BFF 与所有业务模块之间的唯一运营入口。
- 它聚合 manifest、resource、action、approval、audit，天然是权限边界。
- 现有实现已经有 Fastify、Prisma、Zod、jose、platform-kit，可以用成熟框架快速收束，不从零造网关。
- 当前半成品已修掉开放代理的一部分风险，但 GET 资源代理还没有完整的站点作用域过滤。

## 2. 范围

本轮只改：

- `kokoro-platform-admin/src/auth.ts`
- `kokoro-platform-admin/src/gateway.ts`
- `kokoro-platform-admin/src/server.ts`
- `kokoro-platform-admin/src/rbac.ts`
- `kokoro-platform-admin/src/config.ts`
- `kokoro-platform-admin/.env.example`
- `kokoro-platform-admin/prisma/schema.prisma`
- `kokoro-platform-admin/prisma/migrations/20260701000000_add_auth_tables/migration.sql`
- `kokoro-platform-admin/test/unit/*`
- 必要的 platform-admin 技术方案和执行计划文档。

不在本轮做：

- 不改 `kokoro-admin-web` 页面。
- 不改业务子仓 manifest 之外的业务逻辑。
- 不新增 Python 文件。
- 不新增通用 job/queue/Redis。
- 不把 platform-admin 做成业务仓；它只编排运营治理，不持有业务事实。

## 3. 当前取证

已具备的正确方向：

- `createAuthenticator` 支持 `dev`、`proxy`、`oidc` 三种模式。
- `proxy` 模式用 `x-kokoro-proxy-secret` + `x-kokoro-operator`，适配 admin-web/Auth.js BFF。
- `GatewayError`、`prepareAction`、`executeAction` 已把 action 绑定到 manifest 声明的 route。
- `prepareAction` 已做 action 权限、站点作用域、dangerMutation reason。
- `ApprovalRequest` 已做 maker/checker 分离、原子 claim、幂等执行。
- `AuditLog` 已记录成功、失败和被拒动作。
- `/api/resource` 已要求登录操作员并校验 resource 权限。

仍需收束：

- `/api/resource` 只校验 resource 权限，未对返回列表按 `operator.scopeSites` 做站点隔离。
- resource 查询没有显式 `siteId` 参数，scoped operator 读列表时容易拿到跨站数据。
- DB 生命周期规则未写清楚，容易被机械加字段或机械硬删。
- auth 表迁移和 schema 是半成品，需进入明确提交边界。

## 4. 设计决策

### D1. platform-admin 是运营治理网关，不是业务数据仓

允许：

- 操作员身份认证。
- RBAC 和租户作用域检查。
- manifest allowlist。
- action 预检、审批、执行和审计。
- 聚合型视图，例如 sites、user360。

禁止：

- 在 platform-admin 复制业务表。
- 绕过业务模块直接写业务 DB。
- 在 UI 可见性之外放松服务端权限判断。

理由：业务事实归各子仓 DB，platform-admin 只负责运营面治理链路。这样能保持子仓边界清晰，也避免后台成为第二套业务系统。

### D2. 认证和授权职责分离

认证：

- `dev`：本地直连，读 `x-kokoro-operator`，缺省回退 `KOKORO_ADMIN_DEV_OPERATOR`。
- `proxy`：生产推荐，admin-web/BFF 登录后注入 `x-kokoro-operator` 和 `x-kokoro-proxy-secret`。
- `oidc`：备用标准 IdP/JWKS 模式。

授权：

- `resolveOperator(email)` 只接受 active operator。
- RBAC 使用权限 glob：`*`、精确匹配、`prefix.*`。
- 租户作用域使用 `scopeSites`，`["*"]` 表示跨站超级权限。

理由：认证只回答“是谁”，授权回答“能对哪个站点做什么”。两者混在一起会导致 BFF 或 UI 误承担服务端职责。

### D3. 所有运营入口必须走服务端守门链

读资源链路：

```text
request -> authenticate -> resolve active operator -> manifest allowlist -> resource permission -> site scope filter -> response
```

写动作链路：

```text
request -> authenticate -> resolve active operator -> manifest allowlist -> action permission -> site scope -> approval policy -> execute -> audit
```

审批执行链路：

```text
checker authenticate -> self-approval guard -> checker permission -> checker site scope -> atomic claim -> execute -> mark executed/failed
```

理由：成熟后台系统不能依赖前端隐藏按钮。每条 API 入口都必须独立可防御。

### D4. `/api/resource` 明确支持站点过滤

新增 `siteId?: string` 查询参数。

规则：

- 超级作用域 operator 可以不传 `siteId`，得到完整列表。
- scoped operator 不传 `siteId` 时，返回结果必须过滤到 `operator.scopeSites`。
- scoped operator 传 `siteId` 时，必须先校验 `permitsSite(operator.scopeSites, siteId)`，再只返回该站点。
- 对没有 `siteId` 字段的行，不返回给 scoped operator；超级作用域仍可看到。

理由：列表端点是最容易出现横向越权的地方。按响应过滤是当前业务模块 list 端点的最小侵入方案；后续各模块支持 query siteId 后，再把过滤下推到业务仓提高效率。

### D5. DB lifecycle 不机械加字段

当前 platform-admin DB 表分四类：

- `OperatorAccount`：运营身份。当前没有 delete route，业务生命周期用 `status=active|disabled` 表达；禁用不是硬删。未来如果增加删除入口，再补标准 `deletedAt`/`restoredAt` 和 delete/restore route。
- `OperatorRole`：权限配置。当前用 upsert 管理，没有删除入口；不做假删除动作。
- `ApprovalRequest`：审批状态机，必须保留决策轨迹，不做业务删除。
- `AuditLog` / `AuthEvent`：事实日志，append-only，不能软删来改变历史。
- `VerificationToken`：短生命周期认证材料，过期清理可以硬删；它不是业务数据。

理由：软删除是业务生命周期，不是所有表统一加字段。事实日志要保留，token 要可清理，运营账号当前用 disabled 表达停用。不能为了表面统一破坏语义。

### D6. 命名和目录约定

保留结构：

- `src/auth.ts`：认证模式和 token/header 校验。
- `src/rbac.ts`：操作员、角色、权限和站点作用域。
- `src/gateway.ts`：manifest/resource/action 网关编排。
- `src/approval.ts`：审批状态机。
- `src/audit.ts`：审计落库。
- `src/server.ts`：Fastify route 装配。
- `src/config.ts`：环境变量解析。

命名理由：

- 文件按职责命名，不把全部逻辑塞进 `server.ts`。
- TypeScript 文件沿用现有短名；测试放 `test/unit/*.test.ts`。
- 不新增 Python 文件。

### D7. 成熟框架优先

继续使用：

- Fastify 做 HTTP server 和 injection tests。
- Zod 做 query/body/env/Json 边界校验。
- Prisma 做 DB client 和 migration。
- jose 做 JWKS/JWT 验证。
- platform-kit 做 response envelope、health、request context。
- Vitest 做单元和 route 测试。

理由：这些能力已经在仓内落地，继续使用能最快完成可靠闭环；本轮不引入新的重型网关框架。

## 5. 验证策略

红灯测试：

- `gateway.test.ts`：`proxyResource` 对 scoped operator 按 `siteId` 过滤列表。
- `gateway.test.ts`：scoped operator 传越权 `siteId` 时 403，且不上游业务 route。
- `gateway.test.ts`：没有 `siteId` 字段的行不会返回给 scoped operator。
- `gateway.test.ts`：super operator 不传 `siteId` 仍可看完整列表。

门禁：

```bash
pnpm --filter @kokoro/platform-admin typecheck
pnpm --filter @kokoro/platform-admin test
pnpm --filter @kokoro/platform-admin lint
git diff --check
```

如果 schema 或 migration 有变化，必须额外跑：

```bash
pnpm --filter @kokoro/platform-admin db:generate
```

提交前检查：确认没有记录外部禁用引用，也没有新增非标准软删除 helper 命名。
