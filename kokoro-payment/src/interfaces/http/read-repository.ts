import type { PaymentRepository } from "../../domain/repository.js";

export const PAYMENT_READ_METHODS = [
  "listOrders",
  "listPaymentEvents",
  "listPlans",
  "listProviders",
  "listRefunds",
  "listSubscriptions",
  "readAdminStats",
] as const;

export type PaymentReadRepository = Pick<PaymentRepository, (typeof PAYMENT_READ_METHODS)[number]>;
export type PaymentCatalogRepository = Pick<PaymentReadRepository, "listPlans">;
export type PaymentAdminRepository = PaymentReadRepository;

// Runtime capability facade: HTTP composition cannot retain or pass the writable repository.
export function createPaymentReadRepository(repository: PaymentRepository): PaymentReadRepository {
  return Object.freeze({
    listOrders: repository.listOrders.bind(repository),
    listPaymentEvents: repository.listPaymentEvents.bind(repository),
    listPlans: repository.listPlans.bind(repository),
    listProviders: repository.listProviders.bind(repository),
    listRefunds: repository.listRefunds.bind(repository),
    listSubscriptions: repository.listSubscriptions.bind(repository),
    readAdminStats: repository.readAdminStats.bind(repository),
  });
}
