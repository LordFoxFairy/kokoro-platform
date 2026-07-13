import type { IncomingHttpHeaders } from "node:http";
import type { SubscriptionStatus } from "./payment.js";
import type { PaymentProviderKind } from "./provider.js";

// 归一化事件词表：provider 各自的原生事件类型经 parseEvent 收敛到这几种带副作用的内部类型，
// 其余类型一律 ack。状态机（webhook-service.process）只认这里的常量。
export const WEBHOOK_EVENT = {
  paymentSucceeded: "payment_succeeded",
  subscriptionUpdated: "subscription_updated",
  refundSucceeded: "refund_succeeded",
} as const;

// 订阅事件的归一化视图：写订阅行 + 决定是否发放本周期积分所需的最小字段。
export interface ParsedSubscriptionEvent {
  providerSubscriptionId: string;
  teamId: string;
  planId: string;
  status: SubscriptionStatus;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  // true=激活/续期（发放本周期积分）；false=past_due/canceled（只推状态不发放）。
  grantCredits: boolean;
}

// provider 原生事件解析后的归一化视图：驱动状态机与订单联动所需的最小字段。
export interface ParsedWebhookEvent {
  eventId: string;
  eventType: string;
  orderId: string | null;
  // 仅 subscription_updated 事件携带；其余为 null。
  subscription: ParsedSubscriptionEvent | null;
}

// provider 抽象：每个支付渠道自带验签协议与事件格式。
// verifySignature 必须覆盖原始请求字节（rawBody），不允许基于重序列化结果验签。
export interface PaymentWebhookProvider {
  readonly kind: PaymentProviderKind;
  verifySignature(headers: IncomingHttpHeaders, rawBody: Buffer, secret: string): boolean;
  // 原始字节 → 结构化载荷（落库并供 parseEvent 消费）。默认 JSON；
  // 表单编码渠道（如 alipay 异步通知）覆盖此方法自解表单，避免 JSON.parse 误判为非法体。
  decodeBody?(rawBody: Buffer): unknown;
  // 入参是 decodeBody 的产物（webhook 实时路径与落库后的重放共用同一解析）。
  parseEvent(payload: unknown): ParsedWebhookEvent;
}

export type WebhookErrorCode =
  | "payment.webhook_provider_unknown"
  | "payment.webhook_provider_not_implemented"
  | "payment.webhook_secret_unavailable"
  | "payment.webhook_signature_invalid"
  | "payment.webhook_payload_invalid";

export class WebhookError extends Error {
  constructor(
    public readonly code: WebhookErrorCode,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "WebhookError";
  }
}

export function isWebhookError(error: unknown): error is WebhookError {
  return error instanceof WebhookError;
}
