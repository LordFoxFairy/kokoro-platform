import {
  createPrometheusRpcMetrics,
  startHttpServer,
  type RpcSecurityAuditSink,
} from "@kokoro/platform-kit";
import { makePrismaAdminAuthStore } from "./admin-auth-store.js";
import { loadConfig } from "./config.js";
import { createAdminIdentityServer } from "./identity-server.js";
import { createAdminPrisma } from "./prisma.js";

const config = loadConfig();
const prisma = createAdminPrisma(config.adminDbUrl);
const rpcMetrics = createPrometheusRpcMetrics();
const rpcSecurityAudit: RpcSecurityAuditSink = {
  record: (record) => console.info(JSON.stringify({ type: "rpc_security_audit", ...record })),
};
await startHttpServer({
  moduleName: "kokoro-platform-admin",
  port: config.adminPort,
  createServer: () =>
    createAdminIdentityServer({
      store: makePrismaAdminAuthStore(prisma),
      workload: {
        workload: "admin-web",
        audience: "admin-web",
        environment: process.env.NODE_ENV ?? "development",
        secrets: config.auth.proxySecrets,
      },
      telemetry: {
        metrics: rpcMetrics,
        audit: rpcSecurityAudit,
      },
    }),
});
