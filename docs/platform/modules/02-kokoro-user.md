# kokoro-user 技术方案

## 定位

`kokoro-user` 是站点内身份、团队、成员、权限、服务账号和审计的权威模块。

## 职责

拥有：

- User
- ExternalIdentity
- Team/Workspace
- Membership
- Role/Permission
- Invite
- ServiceAccount
- UserAuditLog

不拥有：

- 积分余额
- 支付订单
- 模型 provider secret
- agent session
- artifact

## 当前模型

已实现：

```text
users
teams
memberships
roles
invites
service_accounts
user_audit_logs
```

当前接口：

```text
GET  /healthz
POST /users/ensure
GET  /me/teams
```

## 站点化改造

下一步必须把用户从全局用户改为站点用户。

关键字段：

```text
User.siteId
User.emailNormalized
ExternalIdentity.siteId
Team.siteId
Membership.siteId
Role.siteId?
Invite.siteId
ServiceAccount.siteId
UserAuditLog.siteId
```

唯一约束：

```text
unique(siteId, emailNormalized)
unique(siteId, provider, providerSubject)
unique(siteId, personalOwnerUserId)
unique(siteId, teamId, userId)
```

行为：

- 同邮箱跨站默认创建不同 User。
- 每个站点有自己的 personal workspace。
- 站点封禁、注销、禁用只影响当前站点。
- 跨站账号绑定以后通过显式 AccountLink 做，不能默认合并。

## API 规划

近期补齐：

```text
POST /users/ensure
  必须带 siteId 或 SiteContext header。

GET /me/teams
  必须按 siteId 过滤。

POST /teams
PATCH /teams/:id
POST /invites
POST /invites/accept
PATCH /memberships/:id
DELETE /memberships/:id
POST /service-accounts
POST /service-accounts/:id/rotate
POST /service-accounts/:id/revoke
```

## Admin

admin manifest 已有：

```text
basePath: /admin/users
resources:
  users
  teams
  memberships
  service-accounts
```

后续所有后台查询默认带 `siteId`。只有 platform root admin 可以跨站查询。

## 部署

服务名：

```text
kokoro-user
```

端口：

```text
4211
```

环境变量：

```text
DATABASE_URL_USER
KOKORO_USER_PORT
KOKORO_USER_BASE_URL
KOKORO_SITE_BASE_URL
```

## 测试

必须补的测试：

- 同邮箱不同 site 创建两个 user。
- 同 site 同邮箱幂等返回同一 user。
- `/me/teams` 不返回其它 site 的 team。
- personal team 每个 site 唯一。
- service account token 不跨 site 生效。

## 风险

最大风险是过早做全局用户合并。解决方式：先用 `siteId + emailNormalized`，未来再显式引入 AccountLink。
