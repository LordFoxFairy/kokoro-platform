export const modelPlatformModule = {
  id: "model",
  labelKey: "platform.modules.model",
  packageName: "@kokoro/model",
  directory: "kokoro-model",
  status: "active",
  kind: "model-registry",
  envFile: "kokoro-model/.env.example",
  storage: {
    primary: "mysql",
    databaseEnv: "DATABASE_URL_MODEL",
    ownsMigrations: true,
  },
  runtime: {
    surfaces: ["http", "internal-api"],
    routes: [
      "GET /healthz",
      "POST /provider-accounts/ensure",
      "POST /model-bindings/ensure",
      "GET /model-bindings",
    ],
    notes: [
      "模型配置管理是后台管理核心，优先用 MySQL 保证唯一约束、审计和发布回滚。",
      "LiteLLM 只作为大模型网关，模型可见性、标签、排序、兜底账号仍由本模块治理。",
    ],
  },
  service: {
    serviceName: "kokoro-model",
    portEnv: "KOKORO_MODEL_PORT",
    defaultPort: 4221,
    baseUrlEnv: "KOKORO_MODEL_BASE_URL",
  },
  dependencies: ["user"],
  boundaries: {
    owns: [
      "model catalog",
      "provider accounts",
      "model labels",
      "model slots",
      "fallback policies",
    ],
    doesNotOwn: ["credit ledger", "payment orders", "generated artifacts"],
  },
} as const;
