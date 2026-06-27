# kokoro-user

用户、团队、成员关系、角色、邀请、服务账号和用户审计模块。

## 当前职责

`kokoro-user` 是身份与协作空间的权威模块。其它模块只能通过 API/RPC 读取用户、团队、成员和权限上下文，不能直接写 user 表。

## DDD 结构

```text
src/domain/                 领域类型、repository interface
src/application/            用户和团队用例
src/infrastructure/prisma/  Prisma repository 实现
src/interfaces/http/        HTTP API
src/interfaces/admin/       admin manifest
src/config/                 env 解析
src/module.ts               平台模块元数据
```

## 当前能力

```text
User
Team
Membership
Role
Invite
ServiceAccount
UserAuditLog
```

当前 HTTP 面：

```text
GET  /healthz
POST /users/ensure
GET  /me/teams
```

## 运行与部署

```bash
pnpm --filter @kokoro/user dev
pnpm --filter @kokoro/user start
```

关键 env：

```text
DATABASE_URL_USER
KOKORO_USER_PORT=4211
KOKORO_USER_BASE_URL=http://kokoro-user:4211
```

容器和 Kubernetes 中通过 `kokoro-user` 服务名访问，不在服务间调用里写 `localhost`。模块本身不提供 InMemory fallback，多副本状态全部落 MySQL。

## 下一步补齐

```text
用户:
  禁用/启用
  更新 profile
  lastSeenAt 更新

团队:
  创建 team workspace
  修改 name/slug
  禁用/恢复

成员:
  邀请、接受、撤销
  修改成员角色
  移除成员

权限:
  role -> permissions 校验器
  admin action requiredPermission 校验

服务账号:
  创建、rotate、revoke
  token prefix + secret hash 校验

审计:
  user/team/member/service account 变更写 UserAuditLog
```

## 边界

- 不管理积分余额。
- 不管理支付订单。
- 不管理模型 provider secret。
- 不承担 agent session 状态。
