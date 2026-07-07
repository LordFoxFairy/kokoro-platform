# kokoro-admin-web BFF 与运营界面完善技术方案

> 状态：方案锁定稿。本文只覆盖 `kokoro-admin-web`，把当前未入 git 的 Next.js/Auth.js/Ant Design Pro 后台纳入收束范围；不展开业务子仓或 `kokoro-platform-admin` 后端网关。

## 1. 为什么现在做 admin-web

`kokoro-platform-admin` 已经作为服务端治理网关收束：认证、RBAC、租户作用域、manifest allowlist、审批和审计都在后端强制。admin-web 是运营人员真正使用的 BFF + UI；如果它不显式传站点、env 不可复制、Prisma client 漂移、生产登录配置松散，平台闭环仍然不可靠。

选择本轮聚焦 admin-web 的理由：

- 它是运营人员唯一入口，必须把 `siteId` 选择、可见操作、审批提示和错误反馈做成稳定工作台。
- 它承接 Auth.js magic-link 登录，并通过 middleware 给网关注入 operator + proxy secret。
- 它已经采用 Next.js、Auth.js、Ant Design Pro、Prisma、Zod 和 Vitest，可以用成熟框架快速完成，不重造后台框架。
- 当前子仓还未入 git，必须先清掉构建、忽略规则和站点过滤问题，避免把半成品直接记录。

## 2. 范围

本轮只改：

- `kokoro-admin-web/.gitignore`
- `kokoro-admin-web/.env.example`
- `kokoro-admin-web/package.json`
- `kokoro-admin-web/prisma/schema.prisma`
- `kokoro-admin-web/lib/env.ts`
- `kokoro-admin-web/lib/api.ts`
- `kokoro-admin-web/components/shell/app-shell.tsx`
- `kokoro-admin-web/components/shell/resource-table.tsx`
- `kokoro-admin-web/components/shell/endpoint-table.tsx`
- `kokoro-admin-web/app/*`
- `kokoro-admin-web/lib/auth/*`
- `kokoro-admin-web/test` 或现有 `*.test.ts`
- 必要的 admin-web 技术方案和执行计划文档。

不在本轮做：

- 不改业务子仓。
- 不改 platform-admin 后端网关。
- 不新增 admin-web 自有业务 DB migration。
- 不提交 `.env.local`、`.next/`、`node_modules/`、`tsconfig.tsbuildinfo`。
- 不引入新的 UI 框架替代 Ant Design Pro。

## 3. 当前取证

已具备的正确方向：

- App Router 结构已存在：`app/layout.tsx`、各业务页面、Auth.js route handler。
- `auth.config.ts` 是 edge-safe 配置，middleware 不引入 Prisma。
- `auth.ts` 使用 Auth.js v5 + Nodemailer magic-link + 自定义 adapter，只允许 active operator。
- `middleware.ts` 对 `/api/*` 注入 `x-kokoro-operator` 和 `x-kokoro-proxy-secret`。
- `next.config.ts` 使用 fallback rewrite，把非 Auth.js 的 `/api/*` 同源代理到 platform-admin。
- `AppShell` 使用 Ant Design ProLayout，站点选择器和权限菜单已经成型。
- `ResourceTable` 使用 manifest + RESOURCE_FORMS，动作统一走 `/api/action`。

当前缺口：

- `.env.example` 被子仓 `.gitignore` 排除，运行契约不可复制。
- `next build` 失败：admin-web Prisma schema 已映射 `OperatorAccount`，但 generated client 仍是旧状态。
- `package.json` 没有 `db:generate`/`prebuild`，容易再次出现 Prisma client 漂移。
- `ResourceTable` 拉 `/api/resource` 不传 `siteId`，超级账号会看到全站资源；scoped 账号虽被后端过滤，但下拉仍可能先全量拉再前端过滤。
- `Audit` 页面直接请求 `/api/audit`，scoped operator 会被后端拒绝。
- `lib/env.ts` 注释和 `.env.example` 说生产强制 SMTP，但实际没有在 production 下校验 SMTP 齐全。
- 登录页存在装饰性光晕和负 letter-spacing 类，需要收束成克制的企业后台登录体验。

Next 本地文档说明：

- 项目规则要求读取 `node_modules/next/dist/docs/`。
- 当前安装的 Next.js 版本是 `15.5.19`，实体包内没有 `dist/docs/`，只有 `README.md` 和类型/运行时代码。
- 本轮按现有 App Router 代码、Next 本地类型、`next build` 结果推进。

## 4. 设计决策

### D1. admin-web 是 BFF + UI，不拥有业务事实

允许：

- Auth.js 登录、会话和 middleware。
- 读写 admin DB 中的 auth 相关表：`VerificationToken`、`AuthEvent`，只读 `OperatorAccount`。
- 调 platform-admin `/api/*`。
- 表单、表格、审批弹窗和 Ant Design Pro 工作台。

禁止：

- 直连业务子仓 DB。
- 在前端绕过 platform-admin 调业务服务。
- 在前端复制 RBAC/tenant 作为唯一安全边界。

理由：业务事实归拥有 DB model 的子仓，治理强制归 platform-admin。admin-web 只做操作体验和 BFF 信任头注入。

### D2. DB lifecycle 语义

admin-web 自身不拥有 migration；它映射的是 platform-admin 的 admin DB：

- `OperatorAccount`：只读 active operator，账号停用由 platform-admin `status=disabled` 表达。
- `VerificationToken`：Auth.js 一次性 token，消费时原子硬删除，过期 token 可硬清理；它不是业务数据。
- `AuthEvent`：登录/登出/拒绝登录事实，append-only。

理由：这里没有业务删除入口。硬删除 token 是认证协议语义；审计事件不能软删；操作员账号生命周期不由 admin-web 管理。

### D3. BFF 信任边界

请求链：

```text
browser -> Next middleware -> Auth.js JWT session -> inject operator/proxy-secret -> Next rewrite -> platform-admin
```

规则：

- `/api/auth/*` 必须留给 Auth.js route handler。
- 其它 `/api/*` 通过 rewrite 到 platform-admin。
- middleware 只用 edge-safe `authConfig`，不查 DB。
- `KOKORO_ADMIN_PROXY_SECRET` 必须与 platform-admin `KOKORO_ADMIN_PROXY_SECRETS` 匹配。

理由：Auth.js magic-link 不是标准 OIDC/JWKS；BFF 与网关之间用共享 secret 建立内部信任，再由网关做 RBAC 和租户强制。

### D4. UI 所有资源读取显式带站点

规则：

- `ResourceTable` 对站内资源请求 `/api/resource` 时传当前 `siteId`。
- `site:sites` 是站点目录，不传 `siteId`，避免过滤掉站点本身。
- `optionsFrom.siteScoped` 的下拉必须把 `siteId` 交给后端，再做展示映射。
- 用户 360 的套餐下拉也传当前 `siteId`。
- 审计页请求 `/api/audit?siteId=<current>`；超级账号后续可加“全站”开关，本轮不默认全量。

理由：后端已经能按 siteId 强制过滤，前端应显式表达当前运营上下文。这样超级账号默认也不会误看全站数据。

### D5. 生产 env fail-fast

生产模式必须满足：

- `AUTH_SECRET`
- `DATABASE_URL_ADMIN`
- `KOKORO_GATEWAY_URL`
- `KOKORO_ADMIN_PROXY_SECRET`
- SMTP host/port/from 至少齐全

dev 模式允许 SMTP 留空，magic-link 输出到 server console。

理由：登录链路是入口安全边界；生产不应因为 SMTP 缺失退化成 console link。

### D6. Ant Design Pro 企业后台视觉

保留：

- ProLayout、PageContainer、ProTable、ModalForm、StatisticCard。
- 12/14/16 为主的密实信息层级。
- 明确的 loading/error/empty 状态。
- 图标按钮和菜单图标使用 Ant Design icons 或已有 lucide icons。

调整：

- 去掉登录页装饰性光晕。
- 去掉负 letter-spacing 类。
- 页面内容以工具界面为主，不做营销式 hero。

理由：后台系统要可扫读、可重复操作、低干扰。视觉表达服务效率，不服务宣传。

## 5. 目录与命名

保留结构：

- `app/*/page.tsx`：页面入口。
- `components/shell/*`：后台壳、资源表格和通用 endpoint 表格。
- `components/ui/*`：低层 UI primitive，后续逐步减少与 Antd 重叠。
- `lib/api.ts`：同源 API envelope client。
- `lib/auth/*`：Auth.js adapter、email、events。
- `lib/resource-forms.ts`：按 `moduleId:resourceId` 注册表单。
- `prisma/schema.prisma`：只映射 admin DB auth 表，不拥有迁移。

命名理由：

- 页面按业务域命名，组件按壳层职责命名。
- TypeScript 文件用 kebab-case 或现有短名。
- 不新增 Python 文件。

## 6. 验证策略

红灯测试：

- `lib/env.test.ts`：production 缺 SMTP 时失败，development 可缺 SMTP。
- `lib/api.test.ts` 或 component-adjacent test：query helper 能包含 `siteId`。
- `adapter.test.ts` 保持 active operator、token 原子删除、updateUser 回查。

门禁：

```bash
pnpm --filter @kokoro/admin-web exec prisma generate
pnpm --filter @kokoro/admin-web test
pnpm --filter @kokoro/admin-web lint
pnpm --filter @kokoro/admin-web build
git diff --check
```

提交前检查：

- `.env.example` 入仓，`.env.local` 不入仓。
- `.next/`、`node_modules/`、`tsconfig.tsbuildinfo` 不入仓。
- `pnpm-workspace.yaml` 和 `pnpm-lock.yaml` 与 admin-web package 一起提交。
- 禁用外部引用和非标准软删除 helper 命名不进入仓库。
