# Kokoro 多租户模型（权威设计）

Kokoro 是**多站点 AI 产品工厂**：一套平台能力套出多个独立站点。本文是租户隔离与上下文传播的权威设计，所有业务模块据此对齐。

## 1. 租户层级

```text
Platform        平台（运营方=我们）—— 跨站运营/审计的唯一越界主体
  └─ Site       站点（租户边界，硬隔离）—— 一个 AI 产品实例(music/video/白标)
       └─ Team  团队/组织（站内 B2B 工作区，可选）
            └─ User  终端用户（站内身份）
```

- **siteId 是业务数据的硬隔离边界**。同邮箱在站点 A / 站点 B = 两个不同 User（ADR-001/002）。
- **Site = 租户权威**（kokoro-site，已 siteId-native）；其余业务模块都是 siteId 的消费者。
- Team 是站内可选的组织层（B2B）；个人用户用 `type=personal` 的个人 Team 承载。

## 2. 隔离策略

**共享库 + 行级隔离（siteId 列 + 全查询按 siteId 过滤）**，现在就采用。

- 每张业务表带 `siteId`；唯一约束一律 `(siteId, …)`；repo 层强制按 siteId 过滤。
- **逃生舱（不现在做，仅留口）**：白标大客户可升级为「库级隔离」——repo 工厂按 siteId 选连接。当前 repo 抽象已能后置接入，不预先抽象（YAGNI）。

## 3. 各实体租户归属（决策已定）

| 模块 | 实体 | 归属 | 唯一键（siteId 化后） | 说明 |
|---|---|---|---|---|
| site | Site | 租户本体 | `key` 全局唯一 | 租户标识 |
| site | SiteDomain | 站内 | `host` **全局唯一** | 一个 host 只属一个站，全局唯一是对的；不改 |
| site | SiteApp/Policy/Brand/Seo | 站内 | `(siteId, …)` 已对 | 无需改 |
| user | **User** | **站内** | `(siteId, externalUserId)`、`(siteId, emailNormalized)` | 同邮箱跨站=不同人 |
| user | **Team** | 站内 | `(siteId, slug)` | 个人团队 `(siteId, personalOwnerUserId)` |
| user | Membership/Invite/ServiceAccount | 站内 | 继承 Team.siteId（冗余存 siteId 便于查询/约束） | |
| user | Role | 见 §5 | 平台角色 `(scope=platform,key)`；团队角色 `(siteId,teamId,key)` | RBAC |
| user | UserAuditLog | 站内（领域审计） | +siteId 索引 | 与运营审计区分(§6) |
| model | **ProviderAccount/ModelBinding/ModelLabel** | **平台共享** | 维持 `(provider,key)` 等全局 | 凭证是平台基建，一份服务全站 |
| model | **SiteModelPolicy（新增）** | 站内 | `(siteId, labelKey)` | 站点可见性/分级门控 |
| credit | **CreditAccount** | 站内 | `(siteId, ownerKind, ownerId)` | 同 owner 跨站=独立账户 |
| credit | Ledger/Hold/Usage | 站内 | 继承 Account.siteId（冗余存） | |
| credit | **PricingRule** | **平台共享** | 维持 `(featureKey,…)` | 积分是平台统一计价单位 |
| payment | **Plan** | 站内 | `(siteId, key)` | 各站套餐独立 |
| payment | Order/Subscription/Refund | 站内 | +siteId（索引 `(siteId,teamId,status)`） | |
| payment | PaymentEvent | 平台（provider 驱动） | 维持 `(provider, eventId)` | webhook 去重，站点无关 |

**关键判断**：
- **model 层=平台共享基建**（一份 OpenAI 凭证服务所有站），站点差异只体现在 ① 套餐发多少积分(payment 已站内) ② 哪些模型可见/可用(SiteModelPolicy)。**不把 provider/binding siteId 化**——那是浪费 + 运维泄漏。
- **PricingRule 平台统一**：积分=平台货币，一次模型调用的积分成本全平台一致；站点靠「发多少积分」「能用哪些模型」差异化，不靠改单价。

## 4. RequestContext 与传播

统一请求上下文，边缘解析、全链路透传。

```ts
interface RequestContext {
  requestId: string;          // 链路追踪
  siteId: string | null;      // 业务写必需；缺失即拒绝（platform root 操作除外）
  principal: Principal;       // 谁在调用
  teamId?: string;            // B2B 组织（可选）
}
type Principal =
  | { kind: "user"; userId: string }
  | { kind: "service"; serviceAccountId: string }
  | { kind: "operator"; operatorId: string; roleKey: string }   // 运营后台
  | { kind: "system" };                                          // 内部服务间
```

- **边缘解析**：runtime/web 据 host 调 site `/site-context/resolve` 得 siteId；据 auth 得 principal。
- **透传 header**：`x-kokoro-request-id` / `x-kokoro-site-id` / `x-kokoro-principal`（JSON 或独立头）。
- **platform-kit 提供**：`requestContext` preHandler（解析头→typed context）+ `requireSite` 守卫（业务写缺 siteId → 400）。
- **跨服务转发**：payment→credit 调用必须**转发** request-id + site-id + principal（现在丢了，要补）。

## 5. RBAC（两套作用域，互不混淆）

| 作用域 | 主体 | 角色 | 用途 | 落点 |
|---|---|---|---|---|
| **platform** | 运营人员(operator) | superadmin / ops / support / finance / readonly | 后台运营操作鉴权(退款/发积分/禁用) | **admin 网关**（§7） |
| **tenant** | 终端用户(user) | owner / admin / member | 站内团队权限 | user 模块 Membership.role（未来） |

- 复用 user 的 `Role` 表承载两者：平台角色 `scopeKey="platform"`；团队角色 `scopeKey="team:<teamId>"`。`permissions` JSON 存权限串集合（与 manifest 的 `requiredPermission` 对齐）。
- **第一刀只做 platform 运营 RBAC 的最小集**（网关层），tenant RBAC 后置。

## 6. 审计（运营审计 vs 领域审计）

- **运营审计（第一刀必做）**：每个运营后台动作落**中心审计**——actor(operator)/action/module/target/前值→后值/**理由**/requestId/siteId/result/时间，不可篡改、可追溯。**落在 admin 网关**（所有运营写操作的唯一choke point）。
- **领域审计**：user 的 `UserAuditLog` 等，记录领域内事件（与运营审计区分，后置）。
- **理由必填 + 二次确认**：退款/发积分/禁用在 API schema 层强制 `reason`；危险操作前端二次确认。

## 7. 运营平台架构（守门人 + 纯执行 + 工作台）

```text
运营人员 ─▶ admin 网关(守门人) ─▶ 各业务模块(纯执行) ─▶ 各自 DB
            · operator 认证
            · platform RBAC 鉴权(按动作 requiredPermission)
            · 中心审计(who/what/前后/理由/result)
            · 写操作代理(POST，校验 manifest 声明的 action)
            · 带 siteId+context 转发
                                    模块: siteId 隔离 + 幂等 + 原子条件更新
                                          admin 路由内网 only，信任网关
   运营人员 ◀─ 站点感知任务工作台(用户360/退款流/开站/模型台)
```

- **网关=运营操作权威**：认证/鉴权/审计/代理集中在此；模块保持纯净（不各自重造 RBAC/审计表）。
- **模块=执行**：admin 路由内网隔离、信任网关身份；但仍强制 siteId + 幂等 + 业务不变量。
- **网关自有持久化**：OperatorAccount + Role(platform) + AuditLog。admin 从「无状态聚合器」升级为「有状态运营服务」。

## 8. 能力成熟度（详见 capabilities.md）

地基(siteId 化) → 第一刀(用户360 + 4 操作 + 运营审计/理由/确认) → 第二刀(平台 RBAC + 概览) → 第三刀(审批流/风控/per-site flag·配额)。
