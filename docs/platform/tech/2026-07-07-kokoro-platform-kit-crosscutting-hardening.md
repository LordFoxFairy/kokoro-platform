# kokoro-platform-kit 横切基础设施完善技术方案

> 状态：方案锁定稿。本文只覆盖 `kokoro-platform-kit`，并把当前已有 env/error/internal-client 半成品纳入收束范围；不展开 `platform-admin`、`admin-web` 或任何业务子仓。

## 1. 为什么现在做 platform-kit

`site/user/model/credit/payment/litellm` 已按单仓边界完成首轮收束。剩余平台层要继续推进 admin gateway、运营台、跨服务 active checker、统一错误信封时，不能继续把 request context、错误处理、env 校验和 internal HTTP 调用散落在各仓。

选择 platform-kit 的理由：

- 它是所有 active business modules 的共享底座，稳定后能减少 gateway/admin-web/platform-admin 的重复实现。
- 当前已有正确方向的半成品：`defineEnv`、`AppError`、`registerErrorHandler`、`callService` 和测试，但还没有技术方案锁定边界。
- 它必须保持无业务状态，否则会变成隐藏业务模块。
- 它没有 DB model，不适用业务软删除；本轮重点是横切契约，不是 lifecycle。

## 2. 范围

本轮只改：

- `kokoro-platform-kit/src/config/env.ts`
- `kokoro-platform-kit/src/domain/errors.ts`
- `kokoro-platform-kit/src/http/error-handler.ts`
- `kokoro-platform-kit/src/http/internal-client.ts`
- `kokoro-platform-kit/src/index.ts`
- `kokoro-platform-kit/test/*`
- 必要的 platform-kit 技术方案和执行计划文档。

不在本轮做：

- 不新增 Prisma schema、migration、DB client。
- 不新增业务 DTO。
- 不新增 site/user/credit/payment/model 专用 client。
- 不接 Redis、pino、OpenTelemetry。
- 不改 platform-admin 或 admin-web。

## 3. 当前取证

已有稳定能力：

- `src/admin/manifest-schema.ts`
- `src/admin/manifest-route.ts`
- `src/domain/amount.ts`
- `src/http/request-context.ts`
- `src/http/responses.ts`
- `src/http/start-server.ts`
- `src/http/openapi.ts`

当前半成品：

- `src/config/env.ts`
- `src/domain/errors.ts`
- `src/http/error-handler.ts`
- `src/http/internal-client.ts`
- 对应 `test/env.test.ts`、`test/errors.test.ts`、`test/error-handler.test.ts`、`test/internal-client.test.ts`
- `src/index.ts` 已导出这些新能力。

外部使用现状：

- `kokoro-credit` 已直接使用 `AppError`、`callService`、`RequestContext`。
- `platform-admin` 后续会使用统一 error envelope、internal client、env parser。

## 4. 设计决策

### D1. platform-kit 只做无状态横切工具

允许：

- request context parse/serialize
- uniform response envelope
- Fastify error handler
- env schema parse
- generic internal HTTP client
- amount parser
- admin manifest schema

禁止：

- 查库
- 调业务服务的专用方法
- 保存业务状态
- 判断 site/user/payment/credit/model 策略
- 定义业务 DTO

理由：platform-kit 是 dependency root。它一旦知道业务模块，就会反向依赖业务仓，破坏子仓边界。

### D2. 无 DB lifecycle

`kokoro-platform-kit` 不拥有业务表，没有软删除字段和 delete/restore route。

理由：软删除是业务数据生命周期。kit 只提供工具函数，生命周期由拥有 DB model 的子仓实现。

### D3. `AppError` 是通用载体，registry 只放通用码

保留：

```ts
new AppError(code, httpStatus, message, details?)
```

`ERROR_STATUS` / `appError()` 只放跨服务通用错误：

- `request.invalid`
- `auth.unauthenticated`
- `auth.forbidden`
- `resource.not_found`
- `resource.conflict`
- `rate.limited`
- `upstream.unreachable`
- `upstream.error`
- `internal.error`

不放：

- `credit.insufficient`
- `site.suspended`
- `owner.inactive`
- payment/model/user/site 专用错误。

理由：业务码可以通过 `new AppError("owner.inactive", 409, ...)` 表达，但 registry 不应成为业务枚举大全。否则 kit 会变成业务状态中心。

### D4. error handler 只做 envelope 映射

映射规则：

- ZodError -> 400 `request.invalid`
- AppError -> `error.httpStatus` + `error.code`
- Fastify/client 4xx -> 4xx `request.invalid`
- unknown -> 500 `internal.error`，不泄露原始 message

理由：handler 负责边界格式一致，不负责业务分类。Fastify 内部 error code 不应暴露成平台 error code。

### D5. internal client 是低层 HTTP primitive

`callService(ctx, options)` 只负责：

- 拼接 base URL + path
- 透传 context headers
- 注入 optional internal secret
- JSON body serialize
- 解析 `{ data }` / `{ error }` envelope
- response schema parse
- network failure -> `upstream.unreachable`

不负责：

- owner/site active 判断
- credit quote
- payment order
- model resolve
- retry/backoff/saga

理由：active checker、payment saga、model resolve 都是业务仓职责。kit 只让跨服务调用有统一 envelope 和 context。

### D6. URL 拼接必须稳定

`baseUrl` 和 `path` 允许以下形式：

```text
baseUrl=http://svc
baseUrl=http://svc/
path=/healthz
path=healthz
```

最终都应形成一个合法 URL，不出现 `//healthz` 或 `svchealthz`。

理由：内部服务 base URL 来自 env，容易带或不带尾斜杠；调用点不应反复手写 normalize。

### D7. env parser fail-loud，但不退出进程

`defineEnv(schema, source)`：

- 返回 zod coercion 后的 typed config。
- 失败时抛 `EnvValidationError`，包含逐项 issues。
- 不直接 `process.exit`。

理由：库函数不应控制进程生命周期；服务入口可以 catch 后打印并退出。

## 5. 目录与文件命名

保留/新增结构：

- `src/config/env.ts`
- `src/domain/errors.ts`
- `src/http/error-handler.ts`
- `src/http/internal-client.ts`
- `test/env.test.ts`
- `test/errors.test.ts`
- `test/error-handler.test.ts`
- `test/internal-client.test.ts`

命名理由：

- `config/` 放启动配置解析。
- `domain/` 放跨服务通用 domain primitive，不放业务 domain。
- `http/` 放 Fastify/HTTP 相关工具。
- TypeScript 文件用 kebab-case；不新增 Python 文件。

## 6. 验证策略

红灯测试：

- `errors.test.ts`：registry 不包含业务错误码。
- `error-handler.test.ts`：Fastify 4xx 映射为 `request.invalid`，unknown 不泄露 message。
- `internal-client.test.ts`：baseUrl/path 拼接稳定、error details 透传、invalid success payload 由 schema 拦截。

门禁：

```bash
pnpm --filter @kokoro/platform-kit typecheck
pnpm --filter @kokoro/platform-kit test
pnpm --filter @kokoro/platform-kit lint
git diff --check
```

如果 platform-kit export 影响依赖仓，额外跑：

```bash
pnpm --filter @kokoro/credit typecheck
pnpm --filter @kokoro/credit test
```

## 7. 风险

- 业务码进入 registry，会让 kit 膨胀成业务枚举中心。
- internal client 若知道具体服务，会破坏 dependency direction。
- error handler 若泄露 unknown message，会把内部异常暴露给外部调用方。
- env helper 若直接退出进程，会让测试和嵌入式服务入口难以控制失败路径。
