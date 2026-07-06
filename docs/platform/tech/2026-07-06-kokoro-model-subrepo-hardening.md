# kokoro-model 单仓完善技术方案

> 状态：方案锁定稿。本文只覆盖 `kokoro-model`，并把当前已有 provider/binding/site-policy 管理能力纳入收束范围；不展开 `credit`、`payment`、`platform-admin`、`admin-web`。

## 1. 为什么第五个做 model

`kokoro-site` 已经稳定站点生命周期，`kokoro-user` 已经稳定 user/team owner 生命周期，`kokoro-credit` 已经稳定余额和报价，`kokoro-payment` 已经稳定套餐销售入口。`kokoro-model` 是 AI 产品调用前的能力目录，它决定“这个站点、这个功能、这些标签，应该用哪些 provider account 和 model binding”。

选择 model 的理由：

- L6 模型闭环已经接入 provider-account、binding、site-policy，但生命周期还没有完整收束。
- 模型目录会被 music、video、image、agent、skill 等业务反复调用；目录脏数据会直接导致不可路由、错误 fallback 或误暴露昂贵模型。
- 当前已经有正确基础：`transportKind`、`gatewayModelName` 守卫、active/health 过滤、site policy hidden 过滤。
- Admin manifest 已经出现过“声明动作但无端点”的风险，本轮必须让 manifest 与 route 单源对齐。

## 2. 范围

本轮只改：

- `kokoro-model/prisma/schema.prisma`
- `kokoro-model/src/domain/*`
- `kokoro-model/src/application/model-service.ts`
- `kokoro-model/src/infrastructure/prisma/prisma-model-repository.ts`
- `kokoro-model/src/interfaces/http/*`
- `kokoro-model/src/interfaces/admin/*`
- `kokoro-model/test/unit/*`
- `kokoro-model/test/integration/*`
- 必要的 model migration。

不在本轮做：

- 不改 `credit` pricing 来源模型。
- 不接真实 provider secret 存储或健康检查 worker。
- 不实现 LiteLLM 网关能力；LiteLLM 仍只是 `transportKind=litellm` 的运行网关。
- 不新增套餐权益引擎；plan/entitlement 后续仍由 payment/credit/user 组合提供。
- 不允许业务硬删 provider account 或 model binding；测试夹具和本地 dev DB reset 可以清库。

## 3. 当前取证

DB 现状：

- `ProviderAccount` 有 `provider/key/label/secretRef/status/priority/transportKind/healthStatus/metadata`，没有删除审计列。
- `ModelBinding` 有 `providerAccountId/provider/modelName/displayName/featureKey/labelKeys/inputModalities/outputModalities/transportKind/gatewayModelName/contextWindow/priority/status`，没有删除审计列。
- `ModelLabel` 是模型标签目录，有 `key/displayName/featureKey/tier/defaultBindingId/status`。
- `SiteModelPolicy` 以 `(siteId,labelKey)` 表达某站点对某 label 的 `visible/hidden` 覆盖。

代码现状：

- repository 的 `ensureProviderAccount` 按 `(provider,key)` 幂等 upsert，并把 status 置为 active。
- repository 的 `ensureModelBinding` 按 `(providerAccountId,modelName,transportKind)` 幂等 upsert。
- `resolveModelBindings` 已过滤 binding active、provider active、provider healthStatus != down，并按 priority 排序。
- site policy hidden 会在 resolve 后排除带有 hidden label 的 binding；无 siteId 时保持 legacy 全集行为。
- admin manifest 已声明 provider/binding create、enable、disable 和 site-policy set；`model-labels` 当前应保持只读，不声明无端点写动作。

## 4. 设计决策

### D1. 只给核心可运营配置资源加删除审计

新增删除审计列：

- `ProviderAccount`
- `ModelBinding`

暂不新增删除审计列：

- `ModelLabel`
- `SiteModelPolicy`

理由：provider account 和 binding 是有创建、启停、解析影响的运营资源；删除后必须退出默认业务流通。`ModelLabel` 当前没有 create/update/delete route，是只读目录，先保持只读以避免假能力。`SiteModelPolicy` 的业务语义本身就是 visible/hidden 覆盖，不需要再叠一层删除状态。

### D2. 业务 delete 是软删除，测试清库可以硬删

业务 delete 写入：

```prisma
deletedAt    DateTime?
deletedBy    String?
deleteReason String?
```

测试夹具和本地 `db:reset` 仍可使用 `deleteMany` 清空表。

理由：业务数据要保留审计和 restore 入口；测试硬删只是隔离用例和重建本地数据库，不参与线上语义。

### D3. status 与 deletedAt 分离

- `status=disabled`：资源存在，但暂不参与 resolve。
- `deletedAt != null`：资源退出默认业务流通，只能 admin restore。

恢复删除不会自动改变 disabled 状态。

理由：禁用是运营开关，删除是生命周期治理。二者不能互相覆盖，否则 restore 会误把本来 disabled 的资源重新开放。

### D4. 不复用唯一业务键

保留：

- `ProviderAccount(provider,key)` 唯一约束。
- `ModelBinding(providerAccountId,modelName,transportKind)` 唯一约束。

删除后不允许通过 ensure 复用同一唯一键，只能 restore。

理由：provider secret、模型优先级和历史解析配置都依赖这些稳定身份。复用 key 会让旧配置和新配置在审计上混在一起。

### D5. ensure 不是恢复入口

`ensureProviderAccount` 和 `ensureModelBinding` 遇到已删除资源时返回 lifecycle error：

- `model.provider_account.deleted`
- `model.binding.deleted`

理由：ensure 是配置创建/更新入口，不应绕过运营删除状态。恢复必须由明确的 restore action 完成。

### D6. resolve 必须同时过滤 provider 和 binding 的 deletedAt

`resolveModelBindings` 默认只返回：

- binding `status=active`
- binding `deletedAt=null`
- provider account `status=active`
- provider account `deletedAt=null`
- provider account `healthStatus != down`

理由：模型调用前只允许使用可运营、未删除、健康的候选。删除 provider account 不需要级联删除 binding，但所有绑定必须自然从 resolve 结果消失。

### D7. Admin contract 单源，并禁止假动作

新增 `kokoro-model/src/interfaces/admin/model-admin-contract.ts`，`manifest.ts` 从 contract 导出。

真实动作：

- provider-accounts: `create`, `delete`, `restore`, `disable`, `enable`
- model-bindings: `create`, `delete`, `restore`, `disable`, `enable`
- model-labels: 无动作，只读
- site-policies: `set`

理由：manifest 是运营台和 gateway 的能力契约。声明动作但后端没有 route 会制造必失败按钮，必须用 contract route table 反查。

### D8. 采用现有成熟栈，不重造框架

继续使用：

- Prisma 做 DB schema、migration、typed client。
- Zod 做 HTTP boundary schema。
- Fastify 做 route。
- Vitest 做 unit/integration gates。
- `@kokoro/platform-kit` admin manifest schema 做契约校验。

理由：本轮是业务边界收束，不是框架迁移。成熟库已经覆盖 ORM、输入校验、HTTP 和测试，新增代码只实现领域规则。

## 5. DB 设计

### 5.1 需要删除审计列的表

只给以下表增加删除审计：

- `ProviderAccount`
- `ModelBinding`

不加删除审计：

- `ModelLabel`
- `SiteModelPolicy`

### 5.2 索引

新增：

```prisma
@@index([status, deletedAt, priority])              // ProviderAccount
@@index([deletedAt])                                // ProviderAccount
@@index([featureKey, status, deletedAt, priority])  // ModelBinding
@@index([deletedAt])                                // ModelBinding
```

保留：

- `ProviderAccount(provider,key)` 唯一约束。
- `ModelBinding(providerAccountId,modelName,transportKind)` 唯一约束。
- `SiteModelPolicy(siteId,labelKey)` 唯一约束。

设计理由：

- provider admin 列表、resolve 前置过滤都需要 status/deleted/priority。
- binding 列表和 resolve 都按 feature/status/deleted/priority 过滤。
- 单独 `deletedAt` 索引用于 admin restore workflow 和审计查询。

## 6. 核心业务链路

### A. ensure provider account

输入：`provider/key/label/secretRef/transportKind/priority`。

行为：

- `(provider,key)` 不存在时创建。
- 已存在且未删除时更新配置并保持 active。
- 已存在且已删除时返回 `model.provider_account.deleted`，不自动恢复。

理由：provider account 是 provider secretRef 和优先级的身份锚点，删除后只能通过 restore 明确恢复。

### B. ensure model binding

输入：`providerAccountId/modelName/displayName/featureKey/labelKeys/inputModalities/outputModalities/transportKind/gatewayModelName/contextWindow/priority`。

行为：

- provider account 必须存在且未删除。
- `transportKind=litellm` 必须有 `gatewayModelName`。
- `(providerAccountId,modelName,transportKind)` 不存在时创建。
- 已存在且未删除时更新配置并保持 active。
- 已存在且已删除时返回 `model.binding.deleted`，不自动恢复。

理由：binding 是功能到具体模型的运行解析单元。删除后复用同一个模型名会让历史配置和新配置难以区分。

### C. list model bindings

默认只返回 active 且未删除 binding，并支持 `featureKey`、`labelKey` 过滤。

理由：这是业务可用模型列表，不是审计列表；调用方不应看到已删除候选。

### D. resolve model bindings

解析顺序：

```text
featureKey / labelKey / transportKind
  -> binding active + not deleted
  -> provider active + not deleted + healthStatus != down
  -> site policy hidden label filtering
  -> priority asc, createdAt asc
```

理由：resolve 是所有 AI 调用的前置路由。先过滤生命周期和健康，再应用站点可见性，最后排序 fallback，能避免已删除/停用资源被误调。

### E. delete/restore provider account

建议 routes：

- `DELETE /provider-accounts/:providerAccountId`
- `POST /provider-accounts/:providerAccountId/restore`
- `DELETE /admin/models/provider-accounts/:providerAccountId`
- `POST /admin/models/provider-accounts/:providerAccountId/restore`

删除 provider account 后：

- 默认 admin list 之外的业务读取不可见。
- resolve 自动跳过该 provider 下所有 binding。
- binding rows 保留，不做级联删除。
- restore provider 后，原有未删除且 active 的 binding 可重新参与 resolve。

理由：provider 删除通常是账号、密钥或供应商下线，不应抹掉 binding 配置。保留 binding 让 restore 后可恢复运行。

### F. delete/restore model binding

建议 routes：

- `DELETE /model-bindings/:modelBindingId`
- `POST /model-bindings/:modelBindingId/restore`
- `DELETE /admin/models/bindings/:modelBindingId`
- `POST /admin/models/bindings/:modelBindingId/restore`

删除 binding 后：

- `GET /model-bindings` 不返回。
- `GET /model-bindings/resolve` 不返回。
- provider account 不受影响。
- restore 后按原 status 决定是否参与 resolve。

理由：binding 删除是单模型下线，不应影响同 provider account 下的其他模型。

### G. site policy 保持 upsert 状态模型

`SiteModelPolicy` 继续使用 `visible/hidden`，不新增 delete/restore。

理由：站点策略是覆盖规则，不是可售资源或 provider 配置。需要移除覆盖时，后续可增加明确的 unset/delete-policy 端点；本轮不提前设计假能力。

## 7. 目录与文件命名

遵循现有 TypeScript 子仓命名：

- domain 类型：`src/domain/model.ts`
- 生命周期类型与错误：`src/domain/model-lifecycle.ts`
- repository 接口：`src/domain/repository.ts`
- Prisma 实现：`src/infrastructure/prisma/prisma-model-repository.ts`
- HTTP schema：`src/interfaces/http/schemas.ts`
- HTTP routes：`src/interfaces/http/routes.ts`
- Admin contract：`src/interfaces/admin/model-admin-contract.ts`
- Admin manifest export：`src/interfaces/admin/manifest.ts`

命名理由：

- 与 `credit-lifecycle.ts`、`payment-lifecycle.ts` 对齐。
- 使用 kebab-case 文件名，符合当前 TS 子仓风格。
- 不新增 Python 文件；如后续必须加脚本，使用 snake_case 并放入明确 `scripts/` 目录。
- 对外 action 使用普通 `delete` / `restore` 命名，避免特殊化删除语义。

## 8. 测试策略

单元测试：

- service lifecycle delegation。
- HTTP schema strict boundary。
- admin contract route/action 一致性。
- manifest schema 校验。

集成测试：

- provider account delete/restore。
- model binding delete/restore。
- deleted provider 让 resolve 跳过其全部 binding。
- deleted binding 不出现在 list/resolve。
- ensure 遇到 deleted 唯一键拒绝。
- admin list 包含 deleted rows 以支持 restore workflow。

门禁：

```bash
pnpm --filter @kokoro/model typecheck
pnpm --filter @kokoro/model test
env DATABASE_URL_MODEL=mysql://root:kokoro_root@127.0.0.1:3307/kokoro_model pnpm --filter @kokoro/model test:integration
pnpm --filter @kokoro/model lint
git diff --check
```

同时扫描禁止的特殊 delete 命名，确保公开契约保持普通 `delete` / `restore`。
