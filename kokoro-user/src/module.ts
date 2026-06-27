export const userPlatformModule = {
  id: "user",
  labelKey: "platform.modules.user",
  packageName: "@kokoro/user",
  directory: "kokoro-user",
  status: "active",
  kind: "identity",
  envFile: "kokoro-user/.env.example",
  storage: {
    primary: "mysql",
    databaseEnv: "DATABASE_URL_USER",
    ownsMigrations: true,
  },
  admin: {
    mode: "manifest",
    basePath: "/admin/users",
    manifestExport: "userAdminManifest",
  },
  runtime: {
    surfaces: ["http", "internal-api", "admin-manifest"],
    routes: ["GET /healthz", "POST /users/ensure", "GET /me/teams"],
    notes: [
      "user 是身份、团队、成员关系和服务账号的权威。",
      "其它平台模块通过 internal API 或后续 RPC 读取用户上下文，不直接写 user 数据表。",
    ],
  },
  service: {
    serviceName: "kokoro-user",
    portEnv: "KOKORO_USER_PORT",
    defaultPort: 4211,
    baseUrlEnv: "KOKORO_USER_BASE_URL",
  },
  dependencies: [],
  boundaries: {
    owns: ["users", "teams", "memberships", "roles", "invites", "service accounts", "audit logs"],
    doesNotOwn: ["credit ledger", "model catalog", "payment orders", "generated artifacts"],
  },
} as const;
