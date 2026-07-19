import type { PrismaClient } from "../../../generated/prisma/index.js";
import {
  declareRouteAccess,
  registerOpenApi,
  registerRouteAccess,
  type RouteAccessConfig,
  type ServiceCaller,
} from "@kokoro/platform-kit";
import Fastify from "fastify";
import {
  CreditService,
  type OwnerSiteActiveChecker,
  type RunBillingConfig,
} from "../../application/credit-service.js";
import { createPrismaClient } from "../../infrastructure/prisma/prisma-client.js";
import { PrismaCreditRepository } from "../../infrastructure/prisma/prisma-credit-repository.js";
import { registerCreditAdminRoutes } from "./admin-routes.js";
import { registerCreditRoutes } from "./routes.js";

export interface CreateCreditServerOptions {
  prisma?: PrismaClient;
  // 不传则默认放行（测试/本地）；生产由 main.ts 注入 HttpOwnerSiteChecker 启用跨服务 enforcement。
  activeChecker?: OwnerSiteActiveChecker;
  // 不传则用 DEFAULT_RUN_BILLING_CONFIG（面向 dev）；生产由 main.ts 从 env 注入。
  runBilling?: RunBillingConfig;
  // 不传则不起进程内过期回收 sweeper（测试/本地）；生产由 main.ts 按 env 周期注入。
  // sweeper 只是 /credit/holds/sweep 的定时调用方，停机随 app.close 清理。
  sweepIntervalMs?: number;
  // 入站访问控制配置；不传=空 secret + 非生产=dev 直通（测试/本地）；生产由 main.ts 注入 per-caller secret。
  routeAccess?: RouteAccessConfig;
  // 新账户首次开通即发放的 welcome 授信（微单位）；不传=0=关闭。生产/dev 由 main.ts 从 env 注入。
  welcomeGrantMicros?: bigint;
}

// credit 所需 caller 凭据：session(用量记账)/payment(充值授信)/admin(网关) 入站 + credit(自身出站查 site/user active)。
const CREDIT_REQUIRED_CALLERS: ServiceCaller[] = ["session", "payment", "admin", "credit"];

export function createCreditServer(options: CreateCreditServerOptions = {}) {
  const app = Fastify({
    logger: false,
  });

  registerOpenApi(app, { title: "Kokoro Credit API", version: "0.1.0" });

  // 服务间被调面：default-internal。/healthz 公开；/admin 仅 admin 网关；/credit 归 runtime-internal。
  const ra = options.routeAccess ?? { secrets: {}, isProduction: false };
  registerRouteAccess(app, { ...ra, requiredCallers: CREDIT_REQUIRED_CALLERS });
  declareRouteAccess(app, { path: "/healthz", exact: true }, "public");
  declareRouteAccess(app, "/admin", "admin");
  declareRouteAccess(app, "/credit", "runtime-internal");
  declareRouteAccess(app, "/docs", "runtime-internal");

  const prisma = options.prisma ?? createPrismaClient();
  const repository = new PrismaCreditRepository(prisma);
  const service = new CreditService(
    repository,
    options.activeChecker,
    options.runBilling,
    options.welcomeGrantMicros ?? 0n,
  );

  // WHY: 包进 register 确保路由在 swagger onRoute 钩子就绪后加载，否则 /docs/json paths 漏采。
  void app.register(async (instance) => {
    registerCreditRoutes(instance, service);
    registerCreditAdminRoutes(instance, repository, service);
  });

  // 进程内过期回收 sweeper：仅在注入周期时启动。unref 不阻止进程退出；SIGINT/SIGTERM→app.close→onClose 清理。
  const sweepTimer =
    options.sweepIntervalMs === undefined
      ? undefined
      : setInterval(() => {
          void service.sweepExpiredHolds().catch((error) => {
            console.error("credit hold sweep failed", error);
          });
        }, options.sweepIntervalMs);
  sweepTimer?.unref();

  app.addHook("onClose", async () => {
    if (sweepTimer) {
      clearInterval(sweepTimer);
    }
    if (!options.prisma) {
      await prisma.$disconnect();
    }
  });

  return app;
}
