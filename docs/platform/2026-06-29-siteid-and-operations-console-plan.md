# siteId 化 + 运营控制台 方案（2026-06-29）

定调：Kokoro 是**多站点 AI 产品工厂**。后台不是「按模块看表」，而是**任务导向的运营工作台**；且必须**站点感知**。当前 user/credit/payment 无 siteId，是地基缺口——先补地基，再建工作台。

## 形态

```text
产品面   runtime: web/session/agent —— 用户用的 AI 聊天/Studio
平台面   platform: site/user/model/credit/payment —— 身份/计费/模型/积分骨干
运营面   后台 —— 运营/客服/财务/风控的任务工作台（站点感知）
```

siteId 是第一隔离边界；同邮箱跨站默认不同用户（ADR-001/002）。

## Phase 1：siteId 化（地基）

入口：site 据 host 解析 SiteContext → `x-kokoro-site-id` 等 header；业务模块只消费 siteId。

```text
user     unique(siteId, externalUserId) / unique(siteId, emailNormalized)；Team/Membership/ServiceAccount 加 siteId
credit   CreditAccount unique(siteId, ownerKind, ownerId)；Ledger/Hold/Usage/PricingRule 加 siteId
payment  Plan unique(siteId, key)；Order/Subscription/Refund 加 siteId；PaymentEvent unique(siteId, provider, eventId)
model    provider/binding 平台共享(不加 siteId)；SiteModelPolicy(siteId) 控可见(可后置)
迁移     每模块 scratch 生成 migration → deploy；现有数据回填 default site
跨服务   payment→credit grant/spend 带 siteId
```

约束：所有端点接收 siteId（header 优先，admin 显式传）；repo 一律按 siteId 过滤/约束；缺 siteId 的业务写拒绝；platform root admin 可跨站（审计）。

## 运营平台 6 维度（全景）

```text
1 形态     站点感知的任务工作台（已对齐）
2 易用     全局搜索直达 / 一屏看全+右侧操作 / 操作前预览影响(dry-run) / 理由必填 / 二次确认
3 粒度     RBAC 角色×操作(超管/运营/客服/财务/只读) | 资源粒度(站点级套餐定价模型策略flag配额 · 用户团队级配额限速覆盖黑白名单 · 模型级启停可见) | 精确操作(精确积分/全额或按比例退款)
4 可信     审计日志(谁/何时/对谁/前→后/理由,不可改) | 审批流 maker-checker(大额二级审批) | 可逆补偿+幂等
5 可观测   概览仪表盘(收入/积分负债/用量/各站对比) + 异常告警
6 风控     限速 / 异常检测 / 批量禁用
```

分期（YAGNI）：
- 地基：siteId 化
- 第一刀：用户360 + 4 操作 + **审计日志 + 理由必填 + 二次确认**（审计/理由必须与操作同批，不可后补）
- 第二刀：RBAC 角色权限 + 概览仪表盘
- 第三刀：审批流 + 风控 + per-site/user 配额·flag

## Phase 2：用户360 客服台（首个运营场景）

```text
顶部     站点选择器：选 site → 站内操作
用户360  输入 site + 用户标识 → 一屏：身份 + 积分账户(余额/冻结/账本/用量) + 订单/套餐 + 状态
操作     右侧：发积分 / 退款 / 授予套餐 / 禁用（站内、带 siteId）
聚合     admin 网关带 siteId 调 user+credit+payment 拼全貌
```

## Phase 3

退款流、开站向导（域名/品牌/套餐/模型策略/SEO）、模型运维台（provider/binding 启停+健康+站点模型策略）、概览/风控。

## 工具链

弃用 bun，统一 **pnpm**（kokoro-platform 本就是 pnpm）；session/web 的 bun→pnpm 迁移由运行时 agent 执行。

## 落地纪律

每模块 siteId 化按既有模式（DDD 分层、幂等、原子条件更新、Zod .strict()、scratch→deploy migration、回填 default site），全门禁绿后再推进下一模块。之前草稿的 发积分/退款/禁用 端点并入 siteId 版本。
