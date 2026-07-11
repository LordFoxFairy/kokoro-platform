import type { PaymentProviderKind } from "../../domain/provider.js";
import type { PaymentWebhookProvider } from "../../domain/webhook.js";
import { MockWebhookProvider } from "./mock-webhook-provider.js";

export type WebhookProviderRegistry = ReadonlyMap<PaymentProviderKind, PaymentWebhookProvider>;

// stripe/alipay/wechat 是配置层合法 kind，但验签协议尚未接入——不臆造实现，
// 注册表缺位即 501，接入时在此挂真实 PaymentWebhookProvider。
export function createWebhookProviderRegistry(): WebhookProviderRegistry {
  return new Map<PaymentProviderKind, PaymentWebhookProvider>([["mock", new MockWebhookProvider()]]);
}
