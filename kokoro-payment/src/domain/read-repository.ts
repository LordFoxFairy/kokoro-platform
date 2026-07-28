import type { ListOptions } from "./payment-lifecycle.js";
import type {
  AdminRefund,
  AdminSubscription,
  Order,
  PaymentAdminStats,
  PaymentEvent,
  Plan,
} from "./payment.js";
import type { PaymentProviderConfig } from "./provider.js";

export const PAYMENT_READ_METHODS = [
  "listOrders",
  "listPaymentEvents",
  "listPlans",
  "listProviders",
  "listRefunds",
  "listSubscriptions",
  "readAdminStats",
] as const;

export interface PaymentCatalogRepository {
  listPlans(siteId?: string, options?: ListOptions): Promise<Plan[]>;
}

export interface PaymentAdminRepository extends PaymentCatalogRepository {
  listOrders(siteId?: string): Promise<Order[]>;
  listPaymentEvents(): Promise<PaymentEvent[]>;
  listProviders(): Promise<PaymentProviderConfig[]>;
  listRefunds(siteId?: string): Promise<AdminRefund[]>;
  listSubscriptions(siteId?: string): Promise<AdminSubscription[]>;
  readAdminStats(siteId: string): Promise<PaymentAdminStats>;
}
