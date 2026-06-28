export const sitePlatformModule = {
  id: "site",
  labelKey: "platform.modules.site",
  packageName: "@kokoro/site",
  directory: "kokoro-site",
  status: "active",
  kind: "site",
  envFile: "kokoro-site/.env.example",
  storage: {
    primary: "mysql",
    databaseEnv: "DATABASE_URL_SITE",
    ownsMigrations: true,
  },
  admin: {
    mode: "manifest",
    basePath: "/admin/sites",
    manifestExport: "siteAdminManifest",
  },
  runtime: {
    surfaces: ["http", "internal-api", "admin-manifest"],
    routes: [
      "GET /healthz",
      "GET /sites",
      "POST /sites/upsert",
      "POST /site-domains/upsert",
      "POST /site-apps/upsert",
      "POST /site-policies/upsert",
      "GET /site-context/resolve",
    ],
    notes: [
      "site 是多站点入口和 SiteContext 的权威。",
      "业务子仓消费 siteId，不直接从 host 推断站点。",
      "site 不拥有用户、积分、支付、模型 provider 或 agent 运行态。",
    ],
  },
  service: {
    serviceName: "kokoro-site",
    portEnv: "KOKORO_SITE_PORT",
    defaultPort: 4201,
    baseUrlEnv: "KOKORO_SITE_BASE_URL",
  },
  dependencies: [],
  boundaries: {
    owns: ["sites", "site domains", "site apps", "site policies", "site brand configs", "site seo configs"],
    doesNotOwn: ["users", "teams", "credit ledger", "payment orders", "model provider secrets", "agent jobs"],
  },
} as const;
