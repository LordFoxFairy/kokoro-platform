export const hubPlatformModule = {
  id: "hub",
  labelKey: "platform.modules.hub",
  packageName: "@kokoro/hub",
  directory: "kokoro-hub",
  status: "active",
  kind: "capability-hub",
  envFile: "kokoro-hub/.env.example",
  storage: {
    primary: "mongo",
    ownsMigrations: false,
  },
  admin: {
    mode: "manifest",
    basePath: "/hub/admin",
    manifestExport: "hubAdminManifest",
  },
  runtime: {
    surfaces: ["http", "internal-api", "admin-manifest"],
    routes: [
      "GET /healthz",
      "GET /hub/skills/pool",
      "GET /hub/skills/quota",
      "POST /hub/skills/:scope/:name/enable",
      "POST /hub/skills/:scope/:name/disable",
      "POST /hub/skills/:name/official-flags",
      "DELETE /hub/skills/:scope/:name",
    ],
    notes: [
      "hub 是 skill/MCP 能力中台的管理写面权威（启停/官方位/软删/配额/池查询）。",
      "agent 只读同一 Mongo 走装配热路径（hub 写、agent 读，读写分离同库）；每 run 不跨服务 RPC。",
    ],
  },
  service: {
    serviceName: "kokoro-hub",
    portEnv: "KOKORO_HUB_PORT",
    defaultPort: 4251,
    baseUrlEnv: "KOKORO_HUB_BASE_URL",
  },
  dependencies: [],
  boundaries: {
    owns: [
      "skill registry write surface",
      "per-user skill enable/disable state",
      "skill official flags",
      "namespace upload quota view",
    ],
    doesNotOwn: [
      "skill assembly hot path (kokoro-agent)",
      "package body storage authority",
      "user identity",
      "namespace resolution",
    ],
  },
} as const;
