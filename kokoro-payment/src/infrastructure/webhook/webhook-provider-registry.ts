import type { PaymentProviderKind } from "../../domain/provider.js";
import type { PaymentWebhookProvider } from "../../domain/webhook.js";
import { AlipayWebhookProvider } from "./alipay-webhook-provider.js";
import { MockWebhookProvider } from "./mock-webhook-provider.js";
import { StripeWebhookProvider } from "./stripe-webhook-provider.js";
import { WechatWebhookProvider } from "./wechat-webhook-provider.js";

export type WebhookProviderRegistry = ReadonlyMap<PaymentProviderKind, PaymentWebhookProvider>;

// 真实渠道 kind → 验签实现工厂。mock 始终注册（开发/测试驱动），三真驱动按部署启用清单挂载。
const REAL_PROVIDER_FACTORIES: Record<
  Exclude<PaymentProviderKind, "mock">,
  () => PaymentWebhookProvider
> = {
  stripe: () => new StripeWebhookProvider(),
  alipay: () => new AlipayWebhookProvider(),
  wechat: () => new WechatWebhookProvider(),
};

// fail-loud 门：未在 enabledKinds 内启用的真实渠道，注册表留空位 → 请求命中时 501（不假绿）。
// 默认（不传）只挂 mock，以保证未显式启用的部署对 stripe/alipay/wechat 恒 501。
export function createWebhookProviderRegistry(
  enabledKinds: Iterable<PaymentProviderKind> = [],
): WebhookProviderRegistry {
  const registry = new Map<PaymentProviderKind, PaymentWebhookProvider>([
    ["mock", new MockWebhookProvider()],
  ]);
  for (const kind of enabledKinds) {
    if (kind === "mock") {
      continue;
    }
    registry.set(kind, REAL_PROVIDER_FACTORIES[kind]());
  }
  return registry;
}
