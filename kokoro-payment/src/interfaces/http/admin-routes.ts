import { readRequestContext, registerAdminManifestRoute, sendData, sendError } from "@kokoro/platform-kit";
import type { FastifyInstance } from "fastify";
import type { PaymentService } from "../../application/payment-service.js";
import type { PaymentWebhookService } from "../../application/webhook-service.js";
import { paymentAdminManifest } from "../admin/manifest.js";
import type { PaymentRepository } from "../../domain/repository.js";
import { handlePaymentError } from "./routes.js";
import {
  deleteRequestSchema,
  grantPlanRequestSchema,
  planParamsSchema,
  providerParamsSchema,
  replayPaymentEventParamsSchema,
  upsertProviderRequestSchema,
} from "./schemas.js";

// WHY: 资源 id → 只读 list 方法；按 manifest.resources 注册各资源 route 的 GET。
const RESOURCE_LISTERS: Record<string, (repository: PaymentRepository) => Promise<unknown[]>> = {
  plans: (repository) => repository.listPlans(undefined, { includeDeleted: true }),
  orders: (repository) => repository.listOrders(),
  subscriptions: (repository) => repository.listSubscriptions(),
  "payment-events": (repository) => repository.listPaymentEvents(),
  refunds: (repository) => repository.listRefunds(),
  providers: (repository) => repository.listProviders(),
};

export function registerPaymentAdminRoutes(
  app: FastifyInstance,
  repository: PaymentRepository,
  service: PaymentService,
  webhookService: PaymentWebhookService,
): void {
  registerAdminManifestRoute(app, paymentAdminManifest);

  for (const resource of paymentAdminManifest.resources) {
    const lister = RESOURCE_LISTERS[resource.id];
    if (!lister) {
      continue;
    }
    app.get(resource.route, async (_request, reply) => sendData(reply, await lister(repository)));
  }

  // 运营台聚合总览（B2）：订单按状态计数 + 已支付营收按币种。
  app.get("/admin/payments/stats", async (_request, reply) => sendData(reply, await repository.readAdminStats()));

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

  app.delete("/admin/payments/plans/:planId", async (request, reply) => {
    try {
      const { planId } = planParamsSchema.parse(request.params);
      const input = deleteRequestSchema.parse(request.body);
      const result = await service.deletePlan({ id: planId, deletedBy: input.deletedBy, reason: input.reason });
      return sendData(reply, result);
    } catch (error) {
      return handlePaymentError(error, reply, "payment.plan_delete_failed");
    }
  });

  app.post("/admin/payments/plans/:planId/restore", async (request, reply) => {
    try {
      const { planId } = planParamsSchema.parse(request.params);
      const result = await service.restorePlan({ id: planId });
      return sendData(reply, result);
    } catch (error) {
      return handlePaymentError(error, reply, "payment.plan_restore_failed");
    }
  });

  app.post("/admin/payments/providers/upsert", async (request, reply) => {
    try {
      const input = upsertProviderRequestSchema.parse(request.body);
      const result = await webhookService.upsertProvider(input);
      return sendData(reply, result);
    } catch (error) {
      return handlePaymentError(error, reply, "payment.provider_upsert_failed");
    }
  });

  app.delete("/admin/payments/providers/:key", async (request, reply) => {
    try {
      const { key } = providerParamsSchema.parse(request.params);
      const result = await webhookService.deleteProvider(key);
      return sendData(reply, result);
    } catch (error) {
      return handlePaymentError(error, reply, "payment.provider_delete_failed");
    }
  });

  // 失败事件手动重放：failed→processed|failed；processed 幂等返回。
  app.post("/admin/payments/events/:id/replay", async (request, reply) => {
    try {
      const ctx = readRequestContext(request.headers);
      const { id } = replayPaymentEventParamsSchema.parse(request.params);
      const result = await webhookService.replayEvent(id, ctx.requestId);
      return sendData(reply, result, 200, ctx.requestId);
    } catch (error) {
      return handlePaymentError(error, reply, "payment.event_replay_failed");
    }
  });
}
