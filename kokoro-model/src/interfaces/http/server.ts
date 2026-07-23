import {
  declareRouteAccess,
  registerOpenApi,
  registerRouteAccess,
  type RouteAccessConfig,
  type ServiceCaller,
} from "@kokoro/platform-kit";
import type { PrismaClient } from "../../../generated/prisma/index.js";
import Fastify from "fastify";
import { ModelService } from "../../application/model-service.js";
import { createPrismaClient } from "../../infrastructure/prisma/prisma-client.js";
import { PrismaModelRepository } from "../../infrastructure/prisma/prisma-model-repository.js";
import { registerModelAdminRoutes } from "./admin-routes.js";
import { registerModelRoutes } from "./routes.js";

export interface CreateModelServerOptions {
  prisma?: PrismaClient;
  // 入站访问控制配置；不传=空 secret + 非生产=dev 直通（测试/本地）；生产由 main.ts 注入 per-caller secret。
  routeAccess?: RouteAccessConfig;
}

// model 所需 caller 凭据：session(model-bindings/resolve 可用性权威) + admin(网关) 入站。model 无出站。
const MODEL_REQUIRED_CALLERS: ServiceCaller[] = ["session", "admin"];

export function createModelServer(options: CreateModelServerOptions = {}) {
  const app = Fastify({
    logger: false,
  });

  // WHY: swagger 的 onRoute 钩子须先于路由装好，故 registerOpenApi 须在任何路由注册前调用。
  registerOpenApi(app, { title: "Kokoro Model API", version: "0.1.0" });

  // 服务间被调面：default-internal。/healthz 公开；/admin 仅 admin 网关；provider-accounts/model-bindings 归 runtime-internal。
  const ra = options.routeAccess ?? { secrets: {}, isProduction: false };
  registerRouteAccess(app, { ...ra, requiredCallers: MODEL_REQUIRED_CALLERS });
  declareRouteAccess(app, { path: "/healthz", exact: true }, "public");
  declareRouteAccess(app, { path: "/metrics", exact: true }, "public");
  declareRouteAccess(app, "/admin", "admin");
  declareRouteAccess(app, "/provider-accounts", "runtime-internal");
  declareRouteAccess(app, "/model-bindings", "runtime-internal");
  declareRouteAccess(app, "/model-labels", "runtime-internal");
  declareRouteAccess(app, "/docs", "runtime-internal");

  const prisma = options.prisma ?? createPrismaClient();
  const repository = new PrismaModelRepository(prisma);
  const service = new ModelService(repository);

  // WHY: 路由须包进异步 plugin，确保在 swagger(void register 入队)之后加载，否则 onRoute 漏采 → /docs/json paths 为空。
  void app.register(async (instance) => {
    registerModelRoutes(instance, service);
    registerModelAdminRoutes(instance, repository);
  });

  app.addHook("onClose", async () => {
    if (!options.prisma) {
      await prisma.$disconnect();
    }
  });

  return app;
}
