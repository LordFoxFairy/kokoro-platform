export const paymentPlatformModule = {
  id: "payment",
  labelKey: "platform.modules.payment",
  packageName: "@kokoro/payment",
  directory: "kokoro-payment",
  status: "active",
  kind: "payment",
  envFile: "kokoro-payment/.env.example",
  storage: {
    primary: "mysql",
    databaseEnv: "DATABASE_URL_PAYMENT",
    ownsMigrations: true,
  },
  admin: {
    mode: "manifest",
    basePath: "/admin/payments",
    manifestExport: "paymentAdminManifest",
  },
  runtime: {
    surfaces: ["http", "internal-api", "admin-manifest"],
    routes: [
      "GET /healthz",
      "GET /metrics",
      "GET /plans",
      "GET /admin/payments/manifest",
      "GET /admin/payments/:resource",
      "GET /admin/payments/stats",
    ],
    notes: [
      "redeem-only 阶段只提供 Site 套餐目录和历史支付数据只读管理。",
      "旧 order、payment-event、refund 与 provider webhook 写入口只返回 ACQUISITION_CHANNEL_DISABLED。",
      "运行图不组装 provider SDK、secret resolver、Credit client 或 acquisition worker。",
    ],
  },
  service: {
    serviceName: "kokoro-payment",
    portEnv: "KOKORO_PAYMENT_PORT",
    defaultPort: 4241,
    baseUrlEnv: "KOKORO_PAYMENT_BASE_URL",
  },
  dependencies: [],
  boundaries: {
    owns: ["Site plan catalogue", "historical orders", "historical subscriptions", "historical payment events", "historical refunds"],
    doesNotOwn: ["credit ledger", "runtime usage metering", "payment acquisition", "provider routing"],
  },
} as const;
