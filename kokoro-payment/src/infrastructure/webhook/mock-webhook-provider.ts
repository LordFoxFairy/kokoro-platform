import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { z } from "zod";
import type { ParsedWebhookEvent, PaymentWebhookProvider } from "../../domain/webhook.js";
import { WEBHOOK_EVENT, WebhookError } from "../../domain/webhook.js";

export const MOCK_WEBHOOK_SIGNATURE_HEADER = "x-kokoro-webhook-signature";

// mock 订阅子信封：直接携带归一化订阅字段（mock 是可控的开发/测试驱动，不模拟真实网关编码）。
const mockSubscriptionSchema = z.object({
  providerSubscriptionId: z.string().min(1),
  teamId: z.string().min(1),
  planId: z.string().min(1),
  status: z.enum(["active", "past_due", "canceled"]),
  currentPeriodStart: z.string().datetime().optional(),
  currentPeriodEnd: z.string().datetime().optional(),
});

// mock 事件信封：容忍 provider 附带的额外字段（passthrough），只取归一化所需字段。
const mockWebhookEventSchema = z
  .object({
    eventId: z.string().min(1),
    eventType: z.string().min(1),
    data: z
      .object({
        orderId: z.string().min(1).optional(),
        subscription: mockSubscriptionSchema.optional(),
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
    const sub = parsed.data.data?.subscription;
    return {
      eventId: parsed.data.eventId,
      eventType: parsed.data.eventType,
      orderId: parsed.data.data?.orderId ?? null,
      subscription:
        parsed.data.eventType === WEBHOOK_EVENT.subscriptionUpdated && sub
          ? {
              providerSubscriptionId: sub.providerSubscriptionId,
              teamId: sub.teamId,
              planId: sub.planId,
              status: sub.status,
              currentPeriodStart: sub.currentPeriodStart ? new Date(sub.currentPeriodStart) : null,
              currentPeriodEnd: sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd) : null,
              grantCredits: sub.status === "active",
            }
          : null,
    };
  }
}
