# kokoro-user 单仓完善技术方案

> 状态：本轮已落地到 `kokoro-user`，并把已有未提交半成品纳入重写/收束范围；不展开 `payment`、`credit`、`model`。

## 1. 为什么第二个做 user

`kokoro-site` 已完成租户根生命周期。第二个应做 `kokoro-user`，原因是：

- `kokoro-user` 是 L5 身份闭环根：`User`、`Team`、`Membership` 决定谁拥有资源。
- `credit` 和 `payment` 的核心 owner 都依赖 user/team。如果 owner 生命周期不准，后续授套餐、发积分、扣积分都会出现跨站或禁用绕过。
- 当前 `kokoro-user` 已有未提交的半成品：team upsert、membership change-role、owner active 校验。下一步应该收束它，而不是让半成品长期留在脏工作树。
- 与账务类不同，user/team/service account 都是可恢复资源，适合延续 site 已验证过的标准删除/恢复模型。

## 2. 范围

本轮只改：

- `kokoro-user/prisma/schema.prisma`
- `kokoro-user/src/domain/*`
- `kokoro-user/src/application/user-service.ts`
- `kokoro-user/src/infrastructure/prisma/prisma-user-repository.ts`
- `kokoro-user/src/interfaces/http/*`
- `kokoro-user/src/interfaces/admin/*`
- `kokoro-user/test/unit/*`
- `kokoro-user/test/integration/*`
- 必要时只小改共享能力；本轮最终实现未要求提交共享包或 admin-web 改动。

不在本轮做：

- 不改 `payment/credit/model` schema。
- 不重写 admin-web 整体，只消费 user manifest/contract 必需字段。
- 不硬删业务数据。测试夹具和本地 dev DB reset 可硬删。
- 不把 audit log 设计成可删除业务资源。

## 3. 当前取证

DB 现状：

- `User` 在 `kokoro-user/prisma/schema.prisma:10` 开始，只有 `status/disabledAt`，无 `deletedAt/deletedBy/deleteReason`。
- `Team` 在 `kokoro-user/prisma/schema.prisma:32` 开始，只有 `status/disabledAt`，无删除审计列。
- `Membership` 在 `kokoro-user/prisma/schema.prisma:57` 开始，只有 `status/disabledAt`。
- `Role`、`Invite`、`ServiceAccount` 分别在 `kokoro-user/prisma/schema.prisma:74`、`:91`、`:110` 开始，也没有统一删除审计。
- `UserAuditLog` 在 `kokoro-user/prisma/schema.prisma:129` 开始，是审计表，应保持 append-only，不提供业务 delete/restore。

唯一约束：

- `User(siteId, externalUserId)`：`kokoro-user/prisma/schema.prisma:27`
- `Team(siteId, slug)`：`kokoro-user/prisma/schema.prisma:51`
- `Membership(teamId, userId)`：`kokoro-user/prisma/schema.prisma:69`
- `Role(scopeKey, key)`：`kokoro-user/prisma/schema.prisma:86`
- `ServiceAccount(tokenPrefix)`：`kokoro-user/prisma/schema.prisma:124`

Repository 现状：

- `ensureUserWithPersonalTeam` 在 `kokoro-user/src/infrastructure/prisma/prisma-user-repository.ts:25`，会建用户、个人团队、owner membership。
- 半成品 `upsertTeam` 在 `kokoro-user/src/infrastructure/prisma/prisma-user-repository.ts:39`，但未校验 owner 与 team 同站，也未处理 deleted。
- 半成品 `setMembershipRole` 在 `kokoro-user/src/infrastructure/prisma/prisma-user-repository.ts:64`，只查存在，不查 site/status/deleted。
- `setUserStatus` 在 `kokoro-user/src/infrastructure/prisma/prisma-user-repository.ts:92`，已尝试级联 personal team disable/enable。
- `resolveOwnerActive` 在 `kokoro-user/src/infrastructure/prisma/prisma-user-repository.ts:112`，只查 active/status，未查 deleted。
- admin list 在 `kokoro-user/src/infrastructure/prisma/prisma-user-repository.ts:144`、`:153`、`:162`、`:170`，未过滤 deleted。

HTTP/admin 现状：

- `/users/ensure` 走 header siteId，见 `kokoro-user/src/interfaces/http/routes.ts:23` 到 `:54`。
- 半成品 `/owners/:ownerKind/:ownerId/active` 在 `kokoro-user/src/interfaces/http/routes.ts:56` 到 `:77`。
- 半成品 `/teams/upsert` 在 `kokoro-user/src/interfaces/http/routes.ts:99` 到 `:126`。
- 半成品 `/memberships/change-role` 在 `kokoro-user/src/interfaces/http/routes.ts:128` 到 `:164`。
- manifest 仍手写，`service-accounts.revoke` 在 `kokoro-user/src/interfaces/admin/manifest.ts:100` 到 `:106` 声明了动作但没有 route，属于假动作。

## 4. 设计决策

### D1. 延续 site 的标准 delete/restore 语义

对外方法叫 `deleteUser`、`restoreUser`、`deleteTeam`、`restoreTeam` 等。底层实现是软删除：写 `deletedAt/deletedBy/deleteReason`。

理由：删除是业务语义，软删除是持久化策略。代码里只保留普通业务语义的删除/恢复命名。

### D2. status 与 deletedAt 分离

- `status=disabled`：资源存在但不可用，可被 enable。
- `deletedAt != null`：资源退出业务流通，默认列表、owner active、membership 查询都不可见；只能后台 includeDeleted 或 restore。

理由：禁用和删除影响范围不同。禁用用户要保留身份用于审计/恢复；删除用户要让 owner 校验失败并阻断新业务写入。

### D3. 唯一身份删除后不可复用

删除后的 `externalUserId`、team `slug`、service account `tokenPrefix` 不允许直接复用，必须 restore 或换 key。

理由：

- `externalUserId` 来自外部身份源，复用会让历史订单/积分/审计指向新的自然人。
- team slug 是运营入口和 owner 标识的一部分，复用会污染历史账务。
- service account token 前缀是安全审计线索，删除后复用会影响追责。

### D4. 级联规则只做业务可见性级联，不做物理级联

删除 `User`：

- 用户本身 `deletedAt`。
- personal team `deletedAt`。
- 该用户 memberships `deletedAt`。
- 该用户 owner service accounts，以及 personal team 绑定的 service accounts `deletedAt`。
- 不自动删除普通团队，因为 team 可能有其他成员；普通团队 owner 被删时必须转移 owner 或显式删除 team。

删除 `Team`：

- team `deletedAt`。
- team memberships `deletedAt`。
- team service accounts `deletedAt`。
- team-scoped roles/invites 默认不参与业务读取；是否补 delete 字段随 schema 一起加。

理由：级联只负责业务不可见，保留审计和恢复路径。普通团队 owner 转移是治理动作，不在删除 user 时隐式猜测。

### D5. `UserAuditLog` append-only

`UserAuditLog` 不加 delete/restore 业务动作。可保留 `metadata`、`requestId`，必要时后续设计匿名化。

理由：审计表是证据，不是业务资源。硬删/软删审计都会破坏追责链。

### D6. Admin contract 单源

新增 `kokoro-user/src/interfaces/admin/user-admin-contract.ts`，`manifest.ts` 从它派生。先只在 user 子仓本地单源，不抽全平台包。

Contract 包含：

- resources: users / teams / memberships / service-accounts
- actions: create, disable, enable, delete, restore, change-role
- route/method/kind/requiredPermission
- action request schema 引用或表单字段描述

理由：site 已证明 manifest、route、表单分散会漂移。user 当前已有 `service-accounts.revoke` 无 route，必须用 contract 把假动作清掉。

## 5. DB 设计

### 5.1 需要删除审计列的表

业务资源表统一新增：

```prisma
deletedAt    DateTime?
deletedBy    String?
deleteReason String?
```

目标表：

- `User`
- `Team`
- `Membership`
- `Role`
- `Invite`
- `ServiceAccount`

不加业务删除动作：

- `UserAuditLog`

### 5.2 索引

新增索引建议：

```prisma
@@index([siteId, status, deletedAt])       // User, Team
@@index([deletedAt])                       // User, Team
@@index([userId, status, deletedAt])       // Membership
@@index([teamId, status, deletedAt])       // Membership, Invite, ServiceAccount
@@index([ownerUserId, status, deletedAt])  // ServiceAccount
```

设计理由：

- `resolveOwnerActive` 和 admin list 最常按 `siteId/status/deletedAt` 查询。
- membership 常按 user/team 过滤，必须让 deleted 过滤进入索引。
- service account revoke/list 需要从 team 或 ownerUser 找到可用 token。

### 5.3 本地 DB 策略

开发库可以直接 `db:reset` 丢弃数据，方便 clean schema。业务实现仍必须走软删除。测试夹具可 `deleteMany` 清库。

## 6. 核心业务链路

### A. ensure user

输入：header `x-kokoro-site-id` + body `externalUserId/email/displayName/avatarUrl`。

行为：

- normalize `externalUserId` 只做 trim，不做 lower，除非产品明确外部 ID 大小写不敏感。
- 若 `(siteId, externalUserId)` 已删除，返回 `user.deleted`，不自动恢复。
- 创建/更新 user 后确保 personal team 和 owner membership 未删除。

设计理由：登录/导入不能绕过管理员删除。恢复必须是显式治理动作。

### B. create/upsert team

输入：header siteId + body `slug/name/ownerUserId`。

行为：

- owner user 必须存在、同 site、active、未删除。
- `(siteId, slug)` 删除后不可复用。
- 创建/更新 team 后确保 owner membership 未删除。

设计理由：team 是 payment/credit owner；跨站 owner 或 deleted owner 会直接污染账务归属。

### C. change membership role

输入：`teamId/userId/role`。

行为：

- team 和 user 必须同 site、active、未删除。
- 不允许把最后一个 active owner 降级或删除。
- role change 只更新 membership，不更改 team ownerUserId；owner 转移后续单独动作。

设计理由：membership 是权限链，不能创建跨站 membership，也不能让团队没有 owner。

### D. owner active

输入：header siteId + path `ownerKind/ownerId`。

行为：

- user owner：siteId 一致、status active、deletedAt null。
- team owner：siteId 一致、status active、deletedAt null。
- 任一条件不满足返回 `{active:false}`。

设计理由：credit/payment 调用它做记账前防线，不能抛 500 或泄露资源存在性。

### E. delete/restore

User:

- `DELETE /users/:userId`
- `POST /users/:userId/restore`

Team:

- `DELETE /teams/:teamId`
- `POST /teams/:teamId/restore`

ServiceAccount:

- `DELETE /service-accounts/:serviceAccountId`
- service account 恢复可后置；本轮把原先无 route 的 revoke 假动作改为真实 `delete` 动作。

设计理由：delete 是标准业务语义；restore 是后台治理面必须有的反操作。

## 7. 目录与文件命名

TypeScript 文件：

- 领域生命周期类型：`kokoro-user/src/domain/user-deletion.ts`
- admin 单源契约：`kokoro-user/src/interfaces/admin/user-admin-contract.ts`
- repository 继续在 `kokoro-user/src/infrastructure/prisma/prisma-user-repository.ts`
- HTTP schema 先继续在 `kokoro-user/src/interfaces/http/schemas.ts`；若超过可读边界，再拆 `user-lifecycle-schemas.ts`
- 测试：
  - `kokoro-user/test/integration/user-repository.test.ts`
  - `kokoro-user/test/integration/user-api.test.ts`
  - `kokoro-user/test/integration/user-admin.test.ts`
  - `kokoro-user/test/unit/user-admin-contract.test.ts`

命名规则：

- 文件名 kebab-case。
- 类型名用 `DeleteInput`、`RestoreInput`、`ListOptions`。
- 方法名用 `deleteUser` / `restoreUser`。
- 错误码用 `user.deleted`、`team.deleted`、`membership.deleted`、`service_account.deleted`。

Python：

- 本轮不新增 Python。
- 若必须写一次性脚本，只放 `scripts/` 或 `tmp/`，文件名 lower_snake_case，例如 `tmp/rebuild_user_dev_data.py`，不得进入业务源码目录。

## 8. 风险

- 当前 `kokoro-user` 已有未提交半成品，执行前必须逐文件确认，不得误删用户已有改动。
- 改 schema 必须 `pnpm --filter @kokoro/user db:generate`。
- 由于 `kokoro-user` 当前 generator 未指定 output，需确认是否和 workspace root `@prisma/client` 共用，避免冲掉其它包 client。
- 本地 dev 数据可 reset，但业务实现不能依赖硬删。
- service account token/secret 不应在 admin 列表暴露 `secretHash` 明文字段；若当前 list 暴露，需要在本轮顺手加 mapper 保护。

## 9. 下一步交付物

1. `kokoro-user` 生命周期 TDD 执行计划。
2. repository 红灯测试。
3. Prisma schema + migration + generate。
4. repository/service/http/admin contract 实现。
5. `kokoro-user` typecheck/unit/integration/lint。
6. 必要的 owner active 跨服务验证，为后续 credit/payment 硬化打基础。
