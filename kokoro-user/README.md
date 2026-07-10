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
POST /auth/sessions
```

`POST /auth/sessions` 签发终端用户运行时会话 JWT（web → user，服务间调用）：

```text
入参(body,snake_case): { site_id, external_user_id, email? }
出参:                  { token, namespace, user, team }
行为: resolve-or-create user + personal team → 以 teamId 为 namespace 签 HS256 JWT
声明: sub=teamId(namespace) / iss=kokoro-user / site_id / iat / exp
```

`token` 由 `kokoro-session` 用共享 `KOKORO_AUTH_JWT_SECRET` 验签消费；`sub`(teamId, cuid)
天然不含 `user:/team:/site:` 等前缀，满足 session 的不透明 namespace 不变量。未配置签发密钥时
该端点 fail-closed 返回 503，绝不签发未签名 token。

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
KOKORO_AUTH_JWT_SECRET       # 与 kokoro-session 同名同值；缺省时 /auth/sessions 返回 503
KOKORO_AUTH_JWT_TTL_SECONDS  # 默认 3600
KOKORO_AUTH_JWT_ISSUER       # 默认 kokoro-user
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
