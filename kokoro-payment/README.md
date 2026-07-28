# kokoro-payment

当前以 redeem-only 模式运行：保存既有 Plan、Order、Subscription、PaymentEvent、Refund、Provider 数据，运行时只开放 Site-scoped 套餐目录和只读管理视图。

## 运行时边界

```text
GET  /healthz
GET  /metrics
GET  /plans
GET  /admin/payments/{plans,orders,subscriptions,events,refunds,providers}
GET  /admin/payments/stats?siteId=...
```

已有调用方访问 checkout、order create/confirm/refund/sweep、payment event record 或 provider webhook 时，统一得到 HTTP 503 与 `ACQUISITION_CHANNEL_DISABLED`。Admin manifest 不声明 Payment mutation；旧 mutation URL 不注册。

进程启动图不包含 provider SDK、webhook secret resolver、Credit grant/reverse client 或确认 worker。已知 provider、确认 worker 旧环境变量，以及名称在忽略大小写和分隔符后同时包含 `WEBHOOK` 与 `SECRET` 的任意非空变量，都会以 `payment.acquisition_env_forbidden` 拒绝启动；PATH/HOME、`WEBHOOK_URL`、`SECRET_ROTATION_ID` 等无关变量仍正常丢弃。`seed:packs` 只 upsert Site 套餐目录，不创建或启用 mock provider。

生产 composition root 使用必填 `DATABASE_URL_PAYMENT_READ` 打开独立 read store；该变量不得回退 migration/CLI 使用的 `DATABASE_URL_PAYMENT`，生产账号必须在数据库层只有 SELECT 权限。raw Prisma client 留在 JavaScript `#private` 状态中，read store 将生命周期 `close` 与 recursively frozen `{catalog, admin}` capability 分离（包括每个函数本身），HTTP server 只接收后者。创建订单、记账事件、退款、订阅与 provider mutation 在 server 的类型和运行时对象上都不可表达；完整 `PaymentRepository` / `PrismaPaymentRepository` 不进入生产 HTTP source tree 或服务启动 import graph。

Admin 的 plans/orders/subscriptions/refunds 与 stats 必须携带非空 `siteId`；缺失或空白统一在访问仓储前返回 `400 payment.site_required`。providers/events 是平台全局历史视图，只允许从 Admin plane 访问，Admin gateway 继续要求 wildcard Site 权限。

## 数据与迁移

Prisma schema 和旧 application/provider adapters 暂时保留，作为 Wave 1 / Wave 2A 数据迁移输入；它们不从包入口导出，也不由生产 server 组装。禁止通过直接引用旧 application 文件绕过关闸。

## 验证

```bash
pnpm --filter @kokoro/payment lint
pnpm --filter @kokoro/payment typecheck
pnpm --filter @kokoro/payment test
node --test test/repository/acquisition-channel-disabled.test.mjs
```

Repository gate 固定完整 HTTP 源文件清单、从真实 `main.ts` 启动入口计算的 runtime import graph、Catalog/Admin 各自精确的只读端口、每个可达生产文件的直接 import，以及 dedicated read credential、deployment template 和 catalogue seed。生产依赖限制和代码执行逃逸由 ESLint 的 `no-restricted-imports`、`no-eval`、`no-implied-eval`、`no-new-func` 承重；Prisma adapter 对每个 `#prisma` 引用执行窄 AST 不变量，只允许精确、直接的 read delegate 调用，禁止 raw call、computed access、client/delegate alias 与传递。Fastify `onRoute` 在真实 production/non-production server 构建时记录权威 route cardinality 并拒绝 constraints/alternate-routing metadata，`onReady` 使用 `hasRoute`/`findRoute` 验证最终 router，请求期再用 closure token fail closed；plugin、隐藏路由、后置 hook 及 bind/call/apply 注册均进入同一门禁。OpenAPI 仅验证公开契约，不作为安全边界。数据库权限仍必须由 release integration 证明 read 成功且 `INSERT`/`UPDATE`/`DELETE` 被拒绝。
