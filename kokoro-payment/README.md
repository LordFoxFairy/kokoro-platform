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

进程启动图不包含 provider SDK、webhook secret resolver、Credit grant/reverse client 或确认 worker。旧的 provider/worker 环境变量会被 schema 丢弃，不能重新开启购买通道。`seed:packs` 只 upsert Site 套餐目录，不创建或启用 mock provider。

## 数据与迁移

Prisma schema 和旧 application/provider adapters 暂时保留，作为 Wave 1 / Wave 2A 数据迁移输入；它们不从包入口导出，也不由生产 server 组装。禁止通过直接引用旧 application 文件绕过关闸。

## 验证

```bash
pnpm --filter @kokoro/payment lint
pnpm --filter @kokoro/payment typecheck
pnpm --filter @kokoro/payment test
node --test test/repository/acquisition-channel-disabled.test.mjs
```

七层 repository gate 覆盖 runtime router、webhook router、Admin surface、server assembly、process bootstrap、environment 和 catalogue seed；每层都有注入违规源码的承重 fixture。
