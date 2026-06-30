import { readRequestContext, registerAdminManifestRoute, sendData, sendError } from "@kokoro/platform-kit";
import type { FastifyInstance } from "fastify";
import type { PaymentService } from "../../application/payment-service.js";
import { paymentAdminManifest } from "../admin/manifest.js";
import type { PaymentRepository } from "../../domain/repository.js";
import { handlePaymentError } from "./routes.js";
import { grantPlanRequestSchema } from "./schemas.js";

// WHY: 资源 id → 只读 list 方法；按 manifest.resources 注册各资源 route 的 GET。
const RESOURCE_LISTERS: Record<string, (repository: PaymentRepository) => Promise<unknown[]>> = {
  plans: (repository) => repository.listPlans(),
  orders: (repository) => repository.listOrders(),
  subscriptions: (repository) => repository.listSubscriptions(),
  "payment-events": (repository) => repository.listPaymentEvents(),
  refunds: (repository) => repository.listRefunds(),
};

export function registerPaymentAdminRoutes(
  app: FastifyInstance,
  repository: PaymentRepository,
  service: PaymentService,
): void {
  registerAdminManifestRoute(app, paymentAdminManifest);

  for (const resource of paymentAdminManifest.resources) {
    const lister = RESOURCE_LISTERS[resource.id];
    if (!lister) {
      continue;
    }
    app.get(resource.route, async (_request, reply) => sendData(reply, await lister(repository)));
  }

  app.post("/admin/payments/grant-plan", async (request, reply) => {
    try {
      const ctx = readRequestContext(request.headers);
      if (ctx.siteId === null) {
        return sendError(reply, 400, "payment.site_required", "缺少站点上下文", undefined, ctx.requestId);
      }
      const { teamId, planId } = grantPlanRequestSchema.parse(request.body);
      const order = await service.grantPlanToTeam(ctx.siteId, teamId, planId, ctx.requestId);
      return sendData(reply, order);
    } catch (error) {
      return handlePaymentError(error, reply, "payment.grant_plan_failed");
    }
  });
}
