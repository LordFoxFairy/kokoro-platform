import type { IncomingHttpHeaders } from "node:http";
import type { PaymentProviderKind } from "./provider.js";

// provider 原生事件解析后的归一化视图：驱动状态机与订单联动所需的最小字段。
export interface ParsedWebhookEvent {
  eventId: string;
  eventType: string;
  orderId: string | null;
}

// provider 抽象：每个支付渠道自带验签协议与事件格式。
// verifySignature 必须覆盖原始请求字节（rawBody），不允许基于重序列化结果验签。
export interface PaymentWebhookProvider {
  readonly kind: PaymentProviderKind;
  verifySignature(headers: IncomingHttpHeaders, rawBody: Buffer, secret: string): boolean;
  // 入参是已 JSON 解析的 payload（webhook 实时路径与落库后的重放共用同一解析）。
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
