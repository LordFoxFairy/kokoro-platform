import { registerHealthRoute, registerMetricsRoute } from "@kokoro/platform-kit";
import Fastify, { type FastifyInstance } from "fastify";
import {
  registerAdminAuthConnect,
  type AdminAuthConnectConfig,
} from "./admin-auth-connect.js";

/**
 * Production surface for the legacy Admin database.
 *
 * That database is an identity credential store only. Administrative commands,
 * authorization, approvals and module reads are owned by Platform PostgreSQL and
 * its typed RPC providers, so this server deliberately has no `/api/*` gateway.
 */
export function createAdminIdentityServer(
  adminAuth: AdminAuthConnectConfig,
): FastifyInstance {
  const app = Fastify({ logger: false });
  registerHealthRoute(app, "kokoro-platform-admin-auth");
  registerMetricsRoute(app, "kokoro-platform-admin-auth");
  registerAdminAuthConnect(app, adminAuth);
  return app;
}
