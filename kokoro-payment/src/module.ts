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
    routes: ["GET /healthz", "POST /plans/upsert", "POST /orders", "POST /payment-events/record"],
    notes: [
      "payment 是购买、订单、订阅和支付事件权威。",
      "支付成功后只请求 credit 发放权益或积分，不直接写 credit 账本。",
    ],
  },
  dependencies: ["user", "credit"],
  boundaries: {
    owns: ["plans", "orders", "subscriptions", "payment events", "invoices", "refunds"],
    doesNotOwn: ["credit ledger", "runtime usage metering", "provider routing"],
  },
} as const;
