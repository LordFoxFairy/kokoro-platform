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

export const PAYMENT_CATALOG_READ_METHODS = ["listPlans"] as const;

export const PAYMENT_ADMIN_READ_METHODS = [
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

export interface PaymentAdminRepository {
  listOrders(siteId?: string): Promise<Order[]>;
  listPaymentEvents(): Promise<PaymentEvent[]>;
  listPlans(siteId?: string, options?: ListOptions): Promise<Plan[]>;
  listProviders(): Promise<PaymentProviderConfig[]>;
  listRefunds(siteId?: string): Promise<AdminRefund[]>;
  listSubscriptions(siteId?: string): Promise<AdminSubscription[]>;
  readAdminStats(siteId: string): Promise<PaymentAdminStats>;
}

export interface PaymentReadCapabilities {
  readonly catalog: PaymentCatalogRepository;
  readonly admin: PaymentAdminRepository;
}
