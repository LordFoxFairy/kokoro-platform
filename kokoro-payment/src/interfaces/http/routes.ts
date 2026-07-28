import {
  readRequestContext,
  registerHealthRoute,
  registerMetricsRoute,
  sendData,
  sendError,
} from "@kokoro/platform-kit";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PaymentCatalogRepository } from "./read-repository.js";

export const ACQUISITION_CHANNEL_DISABLED = "ACQUISITION_CHANNEL_DISABLED";

const DISABLED_MESSAGE = "支付购买通道未开放，请使用卡密兑换";

const DISABLED_RUNTIME_ROUTES = [
  "/orders/checkout",
  "/orders",
  "/orders/sweep",
  "/orders/:id/confirm",
  "/orders/:id/refund",
  "/payment-events/record",
] as const;

function acquisitionDisabled(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  const { requestId } = readRequestContext(request.headers);
  return sendError(reply, 503, ACQUISITION_CHANNEL_DISABLED, DISABLED_MESSAGE, undefined, requestId);
}

export function registerPaymentRoutes(app: FastifyInstance, repository: PaymentCatalogRepository): void {
  registerHealthRoute(app, "payment");
  registerMetricsRoute(app, "payment");

  // Redeem-only launch keeps one Site-scoped, read-only catalogue. No provider or order
  // component is needed to serve it, so this path cannot bootstrap acquisition by accident.
  app.get("/plans", async (request, reply) => {
    const ctx = readRequestContext(request.headers);
    if (ctx.siteId === null) {
      return sendError(reply, 400, "payment.site_required", "缺少站点上下文", undefined, ctx.requestId);
    }
    try {
      const plans = (await repository.listPlans(ctx.siteId)).filter(
        (plan) => plan.status === "active" && !plan.deletedAt,
      );
      return sendData(reply, {
        plans: plans.map((plan) => ({
          id: plan.id,
          key: plan.key,
          name: plan.name,
          currency: plan.currency,
          amountMinor: plan.amountMinor,
          creditMicros: plan.creditMicros,
          billingInterval: plan.billingInterval,
        })),
      }, 200, ctx.requestId);
    } catch {
      return sendError(reply, 500, "payment.plan_list_failed", "套餐目录读取失败", undefined, ctx.requestId);
    }
  });

  // Keep stable denial envelopes for existing Web/Session callers while structurally
  // excluding repositories, provider SDKs, secrets and credit clients from the handler.
  for (const route of DISABLED_RUNTIME_ROUTES) {
    app.post(route, acquisitionDisabled);
  }
}
