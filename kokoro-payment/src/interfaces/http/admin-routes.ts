import {
  readRequestContext,
  registerAdminManifestRoute,
  sendData,
  sendError,
  sendZodError,
} from "@kokoro/platform-kit";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { PaymentRepository } from "../../domain/repository.js";
import { paymentAdminManifest } from "../admin/manifest.js";

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
): void {
  registerAdminManifestRoute(app, paymentAdminManifest);

  for (const resource of paymentAdminManifest.resources) {
    const lister = RESOURCE_LISTERS[resource.id];
    if (!lister) continue;
    app.get(resource.route, async (request, reply) => {
      let siteId: string | undefined;
      if (resource.siteScopeField === null) {
        const query = globalAdminListQuerySchema.safeParse(request.query);
        if (!query.success) return sendZodError(reply, query.error);
      } else {
        const scope = readRequiredAdminSite(request, reply);
        if (!scope.ok) return;
        siteId = scope.siteId;
      }
      return sendData(reply, await lister(repository, siteId));
    });
  }

  app.get("/admin/payments/stats", async (request, reply) => {
    const scope = readRequiredAdminSite(request, reply);
    if (!scope.ok) return;
    return sendData(reply, await repository.readAdminStats(scope.siteId));
  });
}

const requiredAdminSiteQuerySchema = z.object({ siteId: z.string().trim().min(1) }).strict();
const globalAdminListQuerySchema = z.object({}).strict();

function readRequiredAdminSite(
  request: FastifyRequest,
  reply: FastifyReply,
): { ok: true; siteId: string } | { ok: false } {
  const rawSiteId = (request.query as Record<string, unknown>).siteId;
  if (typeof rawSiteId !== "string" || rawSiteId.trim().length === 0) {
    const { requestId } = readRequestContext(request.headers);
    sendError(reply, 400, "payment.site_required", "缺少站点上下文", undefined, requestId);
    return { ok: false };
  }
  const query = requiredAdminSiteQuerySchema.safeParse(request.query);
  if (!query.success) {
    sendZodError(reply, query.error);
    return { ok: false };
  }
  return { ok: true, siteId: query.data.siteId };
}
