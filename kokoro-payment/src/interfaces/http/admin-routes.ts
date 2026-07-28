import { registerAdminManifestRoute, sendData, sendZodError } from "@kokoro/platform-kit";
import type { FastifyInstance } from "fastify";
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
        const query = adminSiteListQuerySchema.safeParse(request.query);
        if (!query.success) return sendZodError(reply, query.error);
        siteId = query.data.siteId;
      }
      return sendData(reply, await lister(repository, siteId));
    });
  }

  app.get("/admin/payments/stats", async (request, reply) => {
    const query = requiredAdminSiteQuerySchema.safeParse(request.query);
    if (!query.success) return sendZodError(reply, query.error);
    return sendData(reply, await repository.readAdminStats(query.data.siteId));
  });
}

const adminSiteListQuerySchema = z.object({ siteId: z.string().trim().min(1).optional() }).strict();
const requiredAdminSiteQuerySchema = z.object({ siteId: z.string().trim().min(1) }).strict();
const globalAdminListQuerySchema = z.object({}).strict();
