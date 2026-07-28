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

生产 composition root 使用必填 `DATABASE_URL_PAYMENT_READ` 打开独立 read store；该变量不得回退 migration/CLI 使用的 `DATABASE_URL_PAYMENT`，生产账号必须在数据库层只有 SELECT 权限。raw Prisma client 留在 JavaScript `#private` 状态中，read store 将生命周期 `close` 与 frozen `{catalog, admin}` capability 分离，HTTP server 只接收后者。创建订单、记账事件、退款、订阅与 provider mutation 在 server 的类型和运行时对象上都不可表达；完整 `PaymentRepository` / `PrismaPaymentRepository` 不进入生产 HTTP source tree 或服务启动 import graph。

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

Repository gate 固定完整 HTTP 源文件清单、从真实 `main.ts` 启动入口计算的 runtime import graph、Catalog/Admin 各自精确的只读端口、每个可达生产文件的直接 import、生产路由中的写仓储/SDK/Secret/Credit/worker 组装，以及 dedicated read credential、deployment template 和 catalogue seed。符号分析覆盖词法 shadowing、route bind/call/apply alias、Prisma client/delegate alias；mutation 和 read-only negative fixture 共同承重。OpenAPI 测试在 production 与 non-production 两种配置下固定实际 Fastify method/path 清单；新增、删除或改 method 都会失败。数据库权限仍必须由 release integration 证明 read 成功且 `INSERT`/`UPDATE`/`DELETE` 被拒绝。
