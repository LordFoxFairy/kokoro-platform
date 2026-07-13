import type { PrismaClient } from "../../../generated/prisma/index.js";
import {
  declareRouteAccess,
  registerOpenApi,
  registerRouteAccess,
  type RouteAccessConfig,
  type ServiceCaller,
} from "@kokoro/platform-kit";
import Fastify from "fastify";
import { SiteService } from "../../application/site-service.js";
import { NodeDnsVerifier } from "../../infrastructure/dns/node-dns-verifier.js";
import { createPrismaClient } from "../../infrastructure/prisma/prisma-client.js";
import { PrismaSiteRepository } from "../../infrastructure/prisma/prisma-site-repository.js";
import { registerSiteAdminRoutes } from "./admin-routes.js";
import { registerSiteRoutes } from "./routes.js";

export interface CreateSiteServerOptions {
  prisma?: PrismaClient;
  // 入站访问控制配置；不传=空 secret + 非生产=dev 直通（测试/本地）；生产由 main.ts 注入 per-caller secret。
  routeAccess?: RouteAccessConfig;
}

// site 所需 caller 凭据：credit(查 owner/site active) + admin(网关) 入站。site 无出站。
const SITE_REQUIRED_CALLERS: ServiceCaller[] = ["credit", "admin"];

export function createSiteServer(options: CreateSiteServerOptions = {}) {
  const app = Fastify({
    logger: false,
  });

  registerOpenApi(app, { title: "Kokoro Site API", version: "0.1.0" });

  // 服务间被调面：default-internal。/healthz 公开；/admin 仅 admin 网关；其余（含 /sites）归 runtime-internal。
  const ra = options.routeAccess ?? { secrets: {}, isProduction: false };
  registerRouteAccess(app, { ...ra, requiredCallers: SITE_REQUIRED_CALLERS });
  declareRouteAccess(app, { path: "/healthz", exact: true }, "public");
  declareRouteAccess(app, "/admin", "admin");
  declareRouteAccess(app, "/sites", "runtime-internal");
  declareRouteAccess(app, "/site-domains", "runtime-internal");
  declareRouteAccess(app, "/site-apps", "runtime-internal");
  declareRouteAccess(app, "/site-policies", "runtime-internal");
  declareRouteAccess(app, "/site-feature-flags", "runtime-internal");
  declareRouteAccess(app, "/site-context", "runtime-internal");
  declareRouteAccess(app, "/docs", "runtime-internal");

  const prisma = options.prisma ?? createPrismaClient();
  const repository = new PrismaSiteRepository(prisma);
  const service = new SiteService(repository, new NodeDnsVerifier());

  // 路由须晚于 swagger 插件加载，否则 onRoute 钩子漏采 → /docs/json paths 为空。
  void app.register(async (instance) => {
    registerSiteRoutes(instance, service);
    registerSiteAdminRoutes(instance, repository);
  });

  app.addHook("onClose", async () => {
    if (!options.prisma) {
      await prisma.$disconnect();
    }
  });

  return app;
}
