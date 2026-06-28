# 02 kokoro-user 站点化设计

`kokoro-user` 是站点内身份、workspace、成员、权限和审计的权威模块。后续必须从当前全局用户模型升级为 site scoped 用户模型。

## 核心判断

```text
User 是站点内用户，不是全局邮箱账号。
同邮箱在不同 siteId 下默认是不同 User。
Workspace/Team 默认按 siteId 隔离。
```

## 目标用户体验

```text
用户在 music.example.com 注册 a@example.com
  -> 创建 music 站 User
  -> 创建 music 站 personal workspace
  -> 领取 music 站免费额度

用户在 video.example.com 注册 a@example.com
  -> 创建 video 站 User
  -> 创建 video 站 personal workspace
  -> 领取 video 站免费额度
```

两个账号默认没有任何关系。

## 模型草案

```text
User
  id
  siteId
  emailNormalized
  emailVerifiedAt
  displayName
  avatarUrl
  status = active | disabled | deleted
  disabledAt
  deletedAt
  lastSeenAt
  metadata

ExternalIdentity
  id
  siteId
  userId
  provider
  providerSubject
  emailAtProvider
  linkedAt

Workspace
  id
  siteId
  name
  slug
  type = personal | team
  ownerUserId
  personalOwnerUserId
  status
  metadata

Membership
  id
  siteId
  workspaceId
  userId
  role = owner | admin | member
  status

Role
  id
  siteId
  workspaceId
  key
  permissions
  status

Invite
  id
  siteId
  workspaceId
  emailNormalized
  role
  tokenHash
  status
  expiresAt

ServiceAccount
  id
  siteId
  workspaceId
  ownerUserId
  name
  tokenPrefix
  secretHash
  status

UserAuditLog
  id
  siteId
  actorUserId
  actorService
  workspaceId
  action
  targetType
  targetId
  metadata
  requestId
```

## 唯一约束

```text
User:
  unique(siteId, emailNormalized)

ExternalIdentity:
  unique(siteId, provider, providerSubject)

Workspace:
  unique(siteId, slug)
  unique(siteId, personalOwnerUserId)

Membership:
  unique(siteId, workspaceId, userId)

Invite:
  index(siteId, workspaceId, status)
  index(siteId, emailNormalized)
```

## API 设计

```text
POST /users/ensure
  headers: x-kokoro-site-id
  body: email/provider identity
  result: User + personal Workspace + owner Membership

GET /me/workspaces
  headers: siteId, userId

POST /workspaces
  创建 team workspace

POST /workspaces/:workspaceId/invites
  邀请成员

POST /invites/:token/accept
  接受邀请，必须匹配 siteId

POST /memberships/:id/role
  修改成员角色

POST /users/:id/disable
POST /workspaces/:id/disable
```

## 权限模型

第一阶段保留简单角色：

```text
owner
admin
member
```

后续引入 permission key：

```text
site.admin.manage
workspace.member.manage
payment.order.read
credit.adjust
model.provider.manage
artifact.publish
seo.page.manage
```

权限校验必须带：

```text
siteId
workspaceId
userId
requiredPermission
```

## 审计

所有写操作都写 `UserAuditLog`：

```text
user.ensure
user.disable
workspace.create
workspace.disable
invite.create
invite.accept
membership.role_change
service_account.create
service_account.rotate
```

审计必须带：

```text
siteId
requestId
actor
target
```

## 与 credit/payment 的关系

user 不直接改余额，也不直接创建订单。

user 负责提供：

```text
siteId
userId
workspaceId
membershipRole
permission context
```

credit/payment 用这些上下文做自己的业务判断。

## 迁移当前 P0

当前 schema 里 `externalUserId` 是全局唯一，后续要拆：

```text
User.externalUserId
  -> ExternalIdentity(provider, providerSubject)

User.email
  -> emailNormalized + siteId 唯一

Team
  -> Workspace 或继续 Team 命名，但必须加 siteId
```

建议保守迁移：

```text
1. 新增 siteId 字段，先给现有数据写 default site。
2. 新增 ExternalIdentity 表。
3. 回填 externalUserId 到 ExternalIdentity。
4. 新建 site scoped 唯一约束。
5. 删除或弱化全局 unique externalUserId。
```

## 风险

- 如果继续保留全局 `externalUserId unique`，多站点同 OAuth subject 会被错误合并。
- 如果 workspace 不带 siteId，后台和 artifact 会串。
- 如果 invite token 不绑定 siteId，可能跨站接受邀请。
- 如果 service account 不带 siteId，API key 权限会越界。

## 验收标准

- 同邮箱在两个 site 注册得到两个 User。
- 同 OAuth subject 在两个 site 登录得到两个 User。
- personal workspace 在两个 site 各一份。
- site A 的 userId 不能访问 site B workspace。
- site admin 只能查询本 site 用户和 workspace。
