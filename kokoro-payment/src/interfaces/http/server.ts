import { registerInternalSecretGuard, registerOpenApi } from "@kokoro/platform-kit";
import type { PrismaClient } from "../../../generated/prisma/index.js";
import Fastify from "fastify";
import { PaymentService } from "../../application/payment-service.js";
import { createPrismaClient } from "../../infrastructure/prisma/prisma-client.js";
import { PrismaPaymentRepository } from "../../infrastructure/prisma/prisma-payment-repository.js";
import type { GrantPurchaseCredits, ReverseCredits } from "../../domain/repository.js";
import { registerPaymentAdminRoutes } from "./admin-routes.js";
import { registerPaymentRoutes } from "./routes.js";

export interface CreatePaymentServerOptions {
  prisma?: PrismaClient;
  grantPurchaseCredits: GrantPurchaseCredits;
  reverseCredits: ReverseCredits;
  // 入站信任密钥；不传/空串=受保护端点直通（测试/本地）；生产由 main.ts 从 env 注入启用 fail-closed。
  internalSecret?: string;
  // confirming 悬挂收尾定时器：仅注入周期时启动(测试不注入=无后台 timer)。
  confirmSweepIntervalMs?: number;
  confirmStaleMs?: number;
}

export function createPaymentServer(options: CreatePaymentServerOptions) {
  const app = Fastify({
    logger: false,
  });

  registerOpenApi(app, { title: "Kokoro Payment API", version: "0.1.0" });

  // 服务间被调面：/admin(网关) 校验内部密钥；未配置直通。
  registerInternalSecretGuard(app, {
    secret: options.internalSecret ?? "",
    protectedPrefixes: ["/admin"],
  });

  const prisma = options.prisma ?? createPrismaClient();
  const repository = new PrismaPaymentRepository(prisma);
  const service = new PaymentService(
    repository,
    options.grantPurchaseCredits,
    options.reverseCredits,
  );

  // WHY: 路由须在 swagger onRoute 钩子就绪后加载，故包进 register 而非直接挂 app。
  void app.register(async (instance) => {
    registerPaymentRoutes(instance, service);
    registerPaymentAdminRoutes(instance, repository, service);
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
