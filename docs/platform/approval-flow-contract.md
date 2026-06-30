# 审批流（maker-checker）契约

高危/大额运营操作需第二名运营复核后才执行。**网关中心化、admin 单仓**：业务模块零改动。

## 架构

```text
maker 提交 /api/action(高危) ─▶ 网关判定需审批 ─▶ 暂存 ApprovalRequest(pending, 存整条 action) ─▶ 返回 202 待审批
checker 复核 ─▶ approve ─▶ 网关原样重跑 proxyAction(执行) ─▶ executed/failed
                         └▶ reject ─▶ rejected(从不执行)
```

- 暂存的是**完整 action 载荷**（moduleId/resourceId/actionId/params/body/siteId/reason + requiredPermission 快照）。
- approve 即「现在执行」：用既有 `proxyAction` 打到模块的同一端点，模块自身的守卫（order 必须 paid 等）处理过期态。

## 数据模型（admin 库新表 approval_requests）

```prisma
model ApprovalRequest {
  id              String   @id @default(cuid())
  status          ApprovalStatus @default(pending)   // pending|approved|rejected|executed|failed
  moduleId        String
  resourceId      String
  actionId        String
  params          Json?
  body            Json?
  siteId          String?
  reason          String?
  requiredPermission String
  executionKey    String   // 请求时生成,执行时透传,保证重跑幂等
  requestedById   String
  requestedByEmail String
  decidedById     String?
  decidedByEmail  String?
  decisionNote    String?
  resultStatusCode Int?
  error           String?
  requestedAt     DateTime @default(now())
  decidedAt       DateTime?
  executedAt      DateTime?
  @@index([status, requestedAt])
  @@index([siteId])
}
enum ApprovalStatus { pending approved rejected executed failed }
```

## 策略（哪些 action 需审批）—— admin 侧配置

`needsApproval(action, body): boolean`：
- `kind === "dangerMutation"` → 需审批（退款/禁用 等天然高危）。
- `actionId === "grant"` 且 `body.amountMicros > KOKORO_APPROVAL_GRANT_THRESHOLD_MICROS`（env 配置，默认如 100_000_000=100 积分）→ 需审批（大额发积分）。
- 其余直接执行（现状不变）。
- 阈值/规则是**运营策略**，归 admin 配置，不下放模块 manifest。

## maker-checker 规则

- **请求**：maker 需该 action 的 `requiredPermission`（同现在）+ 在站点作用域内。
- **复核**：checker 需 ① 同一 `requiredPermission`（自己也有权做该操作）② **不是 maker 本人**（杜绝自批）③ 在该 siteId 作用域内 ④ `approval.read`（看审批）。
- 执行审计 actor 记 maker（操作归属 maker），并附 checker 决策元数据。

## 事务/幂等（按 refund saga 同等严谨度）

- **approve 防重复执行**：原子条件转移 `updateMany WHERE id AND status='pending' → 'approved'`；count=0（已决/并发败者）→ 幂等返回既有结果，**绝不二次执行**。
- **重跑幂等**：ApprovalRequest 存 `executionKey`，执行时注入到 action（如 grant 的 idempotencyKey）；底层钱操作（refund=`order-refund:orderId`）本就幂等 → approve 重跑安全收敛。
- **崩溃边界**（approved 已置但 proxyAction 未回）：V1 显式记 failed/可重试；不假装无此窗口。

## 端点（admin 网关）

- `POST /api/action`（改）：`needsApproval` → 建 pending + 审计 `approval_requested` + 返回 `202 {pendingApproval:true, approvalId}`；否则同现状立即执行。
- `GET /api/approvals?status=&siteId=`：列（按 operator 站点作用域 + `approval.read` 过滤）。
- `POST /api/approvals/:id/approve`：校验(非 maker / 有 requiredPermission / 站内) → 原子转移 → 执行 proxyAction → executed/failed + 审计。幂等。
- `POST /api/approvals/:id/reject`（body:note）→ rejected + 审计。

## UI（admin「审批」tab，按 `approval.read` 显隐）

- 待我复核（非我提交、我有权）：approve/reject + 详情(模块.动作/目标/金额/理由/申请人)。
- 我提交的：状态追踪。
- `/api/action` 返回 pendingApproval → toast「已提交审批，待复核」。

## 执行方式说明

本特性 admin 单仓、高内聚、事务敏感 → **不适合多 agent 并发**（同仓单写，且模块零改动）。最佳实现是**一个聚焦的实现单元**（主控直做，或单 agent），按上面契约 + 事务严谨度落地。
若要保持并发节奏，可把它与**真正独立的他仓** deferred 项（如 credit 配额、payment 订单取消）打包成一个 workflow 并发——但那是另两个特性，非审批流本身。
