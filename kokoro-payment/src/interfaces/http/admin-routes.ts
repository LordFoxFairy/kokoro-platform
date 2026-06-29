import { registerAdminManifestRoute, sendData } from "@kokoro/platform-kit";
import type { FastifyInstance } from "fastify";
import { paymentAdminManifest } from "../admin/manifest.js";
import type { PaymentRepository } from "../../domain/repository.js";

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
): void {
  registerAdminManifestRoute(app, paymentAdminManifest);

  for (const resource of paymentAdminManifest.resources) {
    const lister = RESOURCE_LISTERS[resource.id];
    if (!lister) {
      continue;
    }
    app.get(resource.route, async (_request, reply) => sendData(reply, await lister(repository)));
  }
}
