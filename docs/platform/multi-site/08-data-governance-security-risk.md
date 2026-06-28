# 08 数据治理、安全和风险控制

本文补齐多站点默认隔离背后的安全、隐私、风控和审计设计。

## 数据分类

```text
Identity Data
  email、OAuth subject、登录记录。

Workspace Data
  workspace、membership、role、invite。

Financial Data
  order、subscription、refund、credit ledger、bucket。

AI Runtime Data
  prompt、message、tool call、provider response、job trace。

Artifact Data
  audio、video、image、code、document、asset metadata。

SEO/Public Data
  landing page、template、public artifact、public example。

Operational Data
  metrics、cost、error logs、audit logs。
```

默认所有业务数据都带 `siteId`。日志和指标也必须能按 `siteId` 聚合。

## 访问边界

```text
Platform Super Admin:
  可跨站，但所有操作写审计。

Site Admin:
  只能访问当前 site。

Workspace Owner/Admin:
  只能访问当前 site 当前 workspace。

Member:
  只能访问授权 workspace 的资源。

Service Account:
  必须绑定 siteId 和 workspaceId，不能创建全平台业务 key。
```

## 数据泄漏高风险点

```text
1. 查询忘记 siteId filter。
2. invite token 不绑定 siteId。
3. service account 不绑定 siteId。
4. artifact public URL 不绑定 canonical host。
5. job queue payload 丢失 siteId。
6. webhook event 未绑定 siteId。
7. admin manifest 未声明 site scoped resource。
8. analytics 只按 user email 聚合，跨站混算。
```

这些必须变成测试和代码审查 checklist。

## 审计要求

每个关键写操作审计字段：

```text
siteId
actorKind = user | service | provider | system
actorId
workspaceId
action
targetType
targetId
before/after summary
requestId
ipHash
userAgentHash
createdAt
```

关键动作：

```text
site policy change
domain change
brand/SEO change
user disable/delete
workspace member change
service account rotate
offer/price change
credit grant/spend/refund
provider config change
model policy change
artifact publish/unpublish
```

## 风控和滥用

站点级风控必须支持：

```text
signup velocity
free quota farming
payment fraud
provider abuse
prompt abuse
artifact public abuse
API key abuse
same payment instrument across many site accounts
same device/IP high volume signup
```

注意：同邮箱跨站是独立用户，但风控可以有平台级信号。也就是说：

```text
业务身份默认不合并。
风险信号可以平台聚合。
```

这两者不能混淆。

## 删除和保留

站点内用户删除：

```text
停用 User
删除或匿名化 profile
保留必要订单、账本、审计
artifact 按策略删除或保留
public 页面下线
```

站点归档：

```text
保留 financial ledger
保留 audit log
冻结新写入
清理 runtime trace
artifact 冷存储或删除
SEO noindex/410/301
```

## 数据迁移安全

给现有 P0 加 siteId 时：

```text
先创建 default site。
所有现有记录回填 default siteId。
新 API 强制 siteId。
老 API 灰度废弃。
加 site scoped unique。
最后移除全局 unique 假设。
```

禁止：

```text
直接删除旧唯一约束但没有新约束。
先改业务代码但不回填数据。
用 email 做跨站 join。
在日志里输出明文 token 或 provider secret。
```

## 验收标准

- 所有业务查询都有 siteId filter 或明确 platform admin override。
- service account 无法跨站使用。
- webhook/payment/credit/job/artifact 都能追溯 siteId。
- site admin 查不到其它 site 资源。
- 风控能跨站聚合信号，但不会把业务账号默认合并。
