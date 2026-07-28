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

进程启动图不包含 provider SDK、webhook secret resolver、Credit grant/reverse client 或确认 worker。已知 provider、确认 worker 旧环境变量，以及名称同时包含 `WEBHOOK` 与 `SECRET` 的任意非空变量，都会以 `payment.acquisition_env_forbidden` 拒绝启动；PATH/HOME、`WEBHOOK_URL`、`SECRET_ROTATION_ID` 等无关变量仍正常丢弃。`seed:packs` 只 upsert Site 套餐目录，不创建或启用 mock provider。

HTTP 组合层只接收冻结的 `PaymentCatalogRepository` / `PaymentAdminRepository` 只读 facade；创建订单、记账事件、退款、订阅与 provider mutation 在类型和运行时对象上都不可表达。完整 Prisma repository 仅在收窄 adapter 的构造表达式内出现。

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

Repository gate 固定完整 HTTP 源文件清单、runtime 可达 import graph、每个活跃编排文件的直接 import、生产路由中的写仓储/SDK/Secret/Credit/worker 组装，以及 deployment template 和 catalogue seed。OpenAPI 测试另外固定实际 Fastify method/path 清单；新增、删除或改 method 都会失败。每一类 detector 都有恶意 fixture 承重。
