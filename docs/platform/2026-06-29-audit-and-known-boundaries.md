# kokoro-platform 审计结论与已知边界（2026-06-29）

逐个子模块深审三件事：业务链路是否闭环、代码是否有问题、是否合规范。已修复的正确性问题见 git 提交；以下汇总各模块「已闭环」与「刻意未做的边界」。

## 原则

schema 里定义了表/字段、admin manifest 里暴露了动作，但应用层无逻辑者，一律记为「需产品决策后再实现」的边界——**刻意不投机建造，避免过度设计**。这些不是遗漏，是有意推迟到业务规则确定后再做。

## 本轮已修正确性问题（7 项，已测）

```text
credit  spend 改用可用额(balance-held)条件更新——不得动用已冻结资金（原会致 capture 余额变负）
credit  hold/capture/release 并发原子化（原子条件更新/转移），加并发证明测试
model   litellm 绑定强制 gatewayModelName（否则 resolve 返回不可路由项）
payment markOrderPaid 抢占式条件转移（并发确认仅一方生效、已 paid 幂等）
payment toJson 支持 JSON null；删死代码 isRecordNotFoundError
user    ensure 不再重置 status/disabledAt（管理员 disable 不被登录自动解禁）
user    email 规范化（trim + lowercase）
kit     parsePositiveBigIntString 加 /^\d+$/ 守卫（拒 0x/+/空白等钱款入参）
```

## 各模块闭环状态

### kokoro-credit
- **已闭环**：grant / spend、quote → hold → capture / release、usage(settled)、幂等、并发安全。
- **边界（需产品决策）**：hold 过期回收（`expiresAt` / `expired` 休眠，需定惰性回收 or 后台 sweeper 策略）；refund 专用入口及与原 ledger/usage 的关联（现 `reason=refund` 仅能裸 grant，无回链）；`PricingRule.unit` 的换算语义；`UsageRecord` 的 `recorded`/`failed` 状态路径。

### kokoro-payment
- **已闭环**：plan upsert、order(pending) → confirmOrder → credit grant → paid、order/event 幂等、payload 洗净。payment 不写 credit 账本（经 HTTP，守 ADR-003）。
- **边界（需产品决策）**：PaymentEvent → order 关联与 provider webhook 驱动 confirmOrder（现确认靠直接 HTTP，需定签名/映射）；`Refund`/`Subscription`/`canceled`/`refunded` 状态机与周期续费（schema/manifest 有、逻辑空）。

### kokoro-model
- **已闭环**：provider/binding upsert、resolve（featureKey/labelKey、排除 down/disabled provider、priority 有序候选）。
- **边界（需产品决策）**：`ModelLabel`（`defaultBindingId`/`tier`）的 label→binding 解析兜底（表休眠）；`degraded` provider 是否在 resolve 中降权排序。

### kokoro-site
- **已闭环**：site/domain/app/policy upsert、resolveSiteContext（host 规范化、未绑定/未 active → null）。
- **边界（需产品决策）**：`SiteBrandConfig`/`SiteSeoConfig` 的解析投影（表休眠）；`SitePolicy` 在 resolve 中投影给下游；`canonicalHost` 输出给网关做重定向；`SiteDomain` 验证流转（`pending_verification` → active）；多 app 站点的 primary 选择策略。

### kokoro-user
- **已闭环**：ensureUserWithPersonalTeam（user + personal team + owner membership）、listTeamsForUser。
- **边界（需产品决策）**：非个人 `Team`/`Membership` 管理、`Invite` 邀请、`Role`/permission checker、`ServiceAccount`、`UserAuditLog`（表/manifest 有、逻辑空）。注：`admin manifest` 当前暴露的 change-role/disable/revoke 等动作后端尚无对应路由，属此类边界。

### kokoro-platform-kit
- **已闭环**：admin manifest schema、HTTP envelope/responses、startHttpServer、amount 解析。无业务逻辑泄漏（红线守住）。

## 后续

实现任一「边界」项前，先确定其业务规则（过期策略、退款语义、webhook 映射、权限模型、SEO/品牌解析等），再按本仓既有模式（DDD 分层、幂等、原子条件更新、Zod `.strict()` 边界）落地，并补极端边界测试。
