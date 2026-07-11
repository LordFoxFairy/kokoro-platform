import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { z } from "zod";
import type { ParsedWebhookEvent, PaymentWebhookProvider } from "../../domain/webhook.js";
import { WebhookError } from "../../domain/webhook.js";

export const MOCK_WEBHOOK_SIGNATURE_HEADER = "x-kokoro-webhook-signature";

// mock 事件信封：容忍 provider 附带的额外字段（passthrough），只取归一化所需字段。
const mockWebhookEventSchema = z
  .object({
    eventId: z.string().min(1),
    eventType: z.string().min(1),
    data: z
      .object({
        orderId: z.string().min(1).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export function signMockWebhook(rawBody: Buffer | string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

// V1 联调/测试渠道：HMAC-SHA256 over rawBody，签名走 x-kokoro-webhook-signature 头。
export class MockWebhookProvider implements PaymentWebhookProvider {
  readonly kind = "mock" as const;

  verifySignature(headers: IncomingHttpHeaders, rawBody: Buffer, secret: string): boolean {
    const raw = headers[MOCK_WEBHOOK_SIGNATURE_HEADER];
    const signature = Array.isArray(raw) ? raw[0] : raw;
    if (!signature) {
      return false;
    }
    const expected = Buffer.from(signMockWebhook(rawBody, secret), "utf8");
    const provided = Buffer.from(signature, "utf8");
    // 长度不同直接失败；等长时用常数时间比较防时序侧信道。
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  }

  parseEvent(payload: unknown): ParsedWebhookEvent {
    const parsed = mockWebhookEventSchema.safeParse(payload);
    if (!parsed.success) {
      throw new WebhookError(
        "payment.webhook_payload_invalid",
        "mock webhook payload is invalid: expected { eventId, eventType, data?.orderId }",
        400,
      );
    }
    return {
      eventId: parsed.data.eventId,
      eventType: parsed.data.eventType,
      orderId: parsed.data.data?.orderId ?? null,
    };
  }
}
