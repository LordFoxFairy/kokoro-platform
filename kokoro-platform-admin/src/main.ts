import { startHttpServer } from "@kokoro/platform-kit";
import { PrismaAuditSink } from "./audit.js";
import { loadConfig } from "./config.js";
import { createAdminPrisma } from "./prisma.js";
import { createOperatorLookup } from "./rbac.js";
import { createAdminServer } from "./server.js";

const config = loadConfig();
const prisma = createAdminPrisma(config.adminDbUrl);
await startHttpServer({
  moduleName: "kokoro-platform-admin",
  port: config.adminPort,
  createServer: () =>
    createAdminServer(config.modules, {
      audit: new PrismaAuditSink(prisma),
      resolveOperator: createOperatorLookup(prisma),
      prisma,
      approvalGrantThresholdMicros: config.approvalGrantThresholdMicros,
    }),
});
