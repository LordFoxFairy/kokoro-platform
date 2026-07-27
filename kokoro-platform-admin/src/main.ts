import {
  createPrometheusRpcMetrics,
  isProductionEnv,
  startHttpServer,
  type RpcSecurityAuditSink,
} from "@kokoro/platform-kit";
import { PrismaAuditSink } from "./audit.js";
import { createAuthenticator } from "./auth.js";
import { makePrismaAdminAuthStore } from "./admin-auth-store.js";
import { loadConfig } from "./config.js";
import { createAdminPrisma } from "./prisma.js";
import { createOperatorLookup } from "./rbac.js";
import { createAdminServer } from "./server.js";

const config = loadConfig();
// 生产 fail-fast：网关转发模块须以 admin 身份携带凭据，缺失即空 secret 静默直通——启动失败。
if (isProductionEnv() && config.internalSecret.length === 0) {
  throw new Error("生产环境缺少 admin 调用方凭据：请配置 KOKORO_INTERNAL_SECRET_ADMIN");
}
const prisma = createAdminPrisma(config.adminDbUrl);
const rpcMetrics = createPrometheusRpcMetrics();
const rpcSecurityAudit: RpcSecurityAuditSink = {
  record: (record) => console.info(JSON.stringify({ type: "rpc_security_audit", ...record })),
};
await startHttpServer({
  moduleName: "kokoro-platform-admin",
  port: config.adminPort,
  createServer: () =>
    createAdminServer(config.modules, {
      audit: new PrismaAuditSink(prisma),
      resolveOperator: createOperatorLookup(prisma),
      authenticate: createAuthenticator(config.auth),
      prisma,
      approvalGrantThresholdMicros: config.approvalGrantThresholdMicros,
      internalSecret: config.internalSecret,
      adminAuth: {
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
      },
    }),
});
