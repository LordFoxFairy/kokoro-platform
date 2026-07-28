import { readRequestContext, registerAdminManifestRoute, sendData, sendError, sendZodError } from "@kokoro/platform-kit";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
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
const RESOURCE_LISTERS: Record<string, (repository: PaymentRepository, siteId?: string) => Promise<unknown[]>> = {
  plans: (repository, siteId) => repository.listPlans(siteId, { includeDeleted: true }),
  orders: (repository, siteId) => repository.listOrders(siteId),
  subscriptions: (repository, siteId) => repository.listSubscriptions(siteId),
  "payment-events": (repository) => repository.listPaymentEvents(),
  refunds: (repository, siteId) => repository.listRefunds(siteId),
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
    app.get(resource.route, async (request, reply) => {
      let siteId: string | undefined;
      if (resource.siteScopeField === null) {
        const query = globalAdminListQuerySchema.safeParse(request.query);
        if (!query.success) return sendZodError(reply, query.error);
      } else {
        const query = adminSiteListQuerySchema.safeParse(request.query);
        if (!query.success) return sendZodError(reply, query.error);
        siteId = query.data.siteId;
      }
      return sendData(reply, await lister(repository, siteId));
    });
  }

  // 运营台聚合总览（B2）：订单按状态计数 + 已支付营收按币种。
  app.get("/admin/payments/stats", async (request, reply) => {
    const query = requiredAdminSiteQuerySchema.safeParse(request.query);
    if (!query.success) return sendZodError(reply, query.error);
    return sendData(reply, await repository.readAdminStats(query.data.siteId));
  });

  app.post("/admin/payments/grant-plan", async (request, reply) => {
    const ctx = readRequestContext(request.headers);
    try {
      if (ctx.siteId === null) {
        return sendError(reply, 400, "payment.site_required", "缺少站点上下文", undefined, ctx.requestId);
      }
      const { teamId, planId } = grantPlanRequestSchema.parse(request.body);
      const order = await service.grantPlanToTeam(ctx.siteId, teamId, planId, ctx.requestId);
      return sendData(reply, order, 200, ctx.requestId);
    } catch (error) {
      return handlePaymentError(error, reply, "payment.grant_plan_failed", ctx.requestId);
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

const adminSiteListQuerySchema = z.object({ siteId: z.string().trim().min(1).optional() }).strict();
const requiredAdminSiteQuerySchema = z.object({ siteId: z.string().trim().min(1) }).strict();
const globalAdminListQuerySchema = z.object({}).strict();
