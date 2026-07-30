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
      "GET /model-bindings",
      "GET /model-bindings/resolve",
      "GET /model-labels",
    ],
    notes: [
      "HTTP 仅暴露 Session 消费的只读运行时目录；生产写权威只属于 Platform ModelControl。",
      "离线 builtin bootstrap 可直接调用 repository，不经过 Session 可达的 HTTP。",
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
