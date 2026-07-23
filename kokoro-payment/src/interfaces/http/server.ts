import {
  declareRouteAccess,
  registerOpenApi,
  registerRouteAccess,
  type RouteAccessConfig,
  type ServiceCaller,
} from "@kokoro/platform-kit";
import type { PrismaClient } from "../../../generated/prisma/index.js";
import Fastify from "fastify";
import { PaymentService } from "../../application/payment-service.js";
import { PaymentWebhookService, type WebhookSecretResolver } from "../../application/webhook-service.js";
import { createPrismaClient } from "../../infrastructure/prisma/prisma-client.js";
import { PrismaPaymentRepository } from "../../infrastructure/prisma/prisma-payment-repository.js";
import { createWebhookProviderRegistry } from "../../infrastructure/webhook/webhook-provider-registry.js";
import type { PaymentProviderKind } from "../../domain/provider.js";
import type { GrantPurchaseCredits, ReverseCredits } from "../../domain/repository.js";
import { registerPaymentAdminRoutes } from "./admin-routes.js";
import { registerPaymentRoutes } from "./routes.js";
import { registerPaymentWebhookRoutes } from "./webhook-routes.js";

export interface CreatePaymentServerOptions {
  prisma?: PrismaClient;
  grantPurchaseCredits: GrantPurchaseCredits;
  reverseCredits: ReverseCredits;
  // 入站访问控制配置；不传=空 secret + 非生产=dev 直通（测试/本地）；生产由 main.ts 注入 per-caller secret。
  routeAccess?: RouteAccessConfig;
  // confirming 悬挂收尾定时器：仅注入周期时启动(测试不注入=无后台 timer)。
  confirmSweepIntervalMs?: number;
  confirmStaleMs?: number;
  // provider webhookSecretRef(env 变量名) → 密钥明文；默认读 process.env。
  webhookSecretResolver?: WebhookSecretResolver;
  // 启用真实验签的渠道 kind；未列出者注册表留空→501。默认只 mock。
  enabledProviderKinds?: PaymentProviderKind[];
}

// payment 所需 caller 凭据：admin(网关) + payment(自身出站调 credit) + web-bff(用户面店面/结账)。
const PAYMENT_REQUIRED_CALLERS: ServiceCaller[] = ["admin", "payment", "web-bff"];

export function createPaymentServer(options: CreatePaymentServerOptions) {
  const app = Fastify({
    logger: false,
  });

  registerOpenApi(app, { title: "Kokoro Payment API", version: "0.1.0" });

  // 服务间被调面：default-internal。/healthz 与 /payments/webhooks(另验 provider 签名) 公开；
  // /admin 仅 admin 网关；orders/plans/payment-events 归 runtime-internal。
  const ra = options.routeAccess ?? { secrets: {}, isProduction: false };
  registerRouteAccess(app, { ...ra, requiredCallers: PAYMENT_REQUIRED_CALLERS });
  declareRouteAccess(app, { path: "/healthz", exact: true }, "public");
  declareRouteAccess(app, { path: "/metrics", exact: true }, "public");
  declareRouteAccess(app, "/payments/webhooks", "public");
  // 用户面（web-bff）：店面目录 GET /plans（exact）+ 结账 POST /orders/checkout。须先于下方 /plans、
  // /orders 前缀声明——resolveLevel 最长路径优先、同长先声明者胜：/orders/checkout(16) 长于 /orders(7)
  // 恒胜；exact /plans(6) 与前缀 /plans(6) 同长,故此处先声明以在 GET /plans 上胜出。upsert/:id 仍归内部。
  declareRouteAccess(app, { path: "/plans", exact: true }, "web-bff");
  declareRouteAccess(app, "/orders/checkout", "web-bff");
  declareRouteAccess(app, "/admin", "admin");
  declareRouteAccess(app, "/orders", "runtime-internal");
  declareRouteAccess(app, "/plans", "runtime-internal");
  declareRouteAccess(app, "/payment-events", "runtime-internal");
  declareRouteAccess(app, "/docs", "runtime-internal");

  const prisma = options.prisma ?? createPrismaClient();
  const repository = new PrismaPaymentRepository(prisma);
  const service = new PaymentService(
    repository,
    options.grantPurchaseCredits,
    options.reverseCredits,
  );
  const webhookService = new PaymentWebhookService(
    repository,
    service,
    createWebhookProviderRegistry(options.enabledProviderKinds ?? []),
    options.webhookSecretResolver ?? ((secretRef) => process.env[secretRef]),
  );

  // WHY: 路由须在 swagger onRoute 钩子就绪后加载，故包进 register 而非直接挂 app。
  void app.register(async (instance) => {
    registerPaymentRoutes(instance, service);
    registerPaymentAdminRoutes(instance, repository, service, webhookService);
  });

  // webhook 单独 encapsulation：该域内 body 保留原始字节供验签，不影响其余 JSON 路由。
  void app.register(async (instance) => {
    registerPaymentWebhookRoutes(instance, webhookService);
  });

  // confirming 悬挂收尾 sweeper(同 credit hold sweeper 形态):unref 不阻退出;onClose 清理。
  const staleMs = options.confirmStaleMs ?? 120_000;
  const sweepTimer =
    options.confirmSweepIntervalMs === undefined || options.confirmSweepIntervalMs === 0
      ? undefined
      : setInterval(() => {
          void service.sweepStaleConfirmingOrders(staleMs, "confirm-sweep").catch((error) => {
            console.error("payment confirm sweep failed", error);
          });
        }, options.confirmSweepIntervalMs);
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
