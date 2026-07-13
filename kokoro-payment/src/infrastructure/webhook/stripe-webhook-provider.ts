import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { z } from "zod";
import type { ParsedWebhookEvent, PaymentWebhookProvider } from "../../domain/webhook.js";
import { WEBHOOK_EVENT, WebhookError } from "../../domain/webhook.js";
import {
  buildSubscriptionEvent,
  unixSecondsToDate,
  webhookMetadataSchema,
} from "./normalize.js";

export const STRIPE_SIGNATURE_HEADER = "stripe-signature";
// Stripe 默认容差 5 分钟（防重放）。
const DEFAULT_TOLERANCE_SECONDS = 300;

// Stripe webhook 事件信封：只取归一化所需字段，其余 passthrough。
const stripeEventSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    data: z
      .object({
        object: z
          .object({
            id: z.string().optional(),
            status: z.string().optional(),
            current_period_start: z.union([z.number(), z.string()]).optional(),
            current_period_end: z.union([z.number(), z.string()]).optional(),
            metadata: webhookMetadataSchema.optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

// Stripe subscription.status → 内部订阅态。active/trialing 发放本周期积分。
function mapSubscriptionStatus(raw: string | undefined): {
  status: "active" | "past_due" | "canceled";
  grantCredits: boolean;
} {
  if (raw === "active" || raw === "trialing") {
    return { status: "active", grantCredits: true };
  }
  if (raw === "canceled" || raw === "incomplete_expired") {
    return { status: "canceled", grantCredits: false };
  }
  return { status: "past_due", grantCredits: false };
}

// 测试向量构造：Stripe `t=<ts>,v1=<hmac>` 头。签名覆盖 `${t}.${rawBody}`。
export function signStripeWebhook(rawBody: Buffer | string, secret: string, timestamp: number): string {
  const payload = `${timestamp}.${typeof rawBody === "string" ? rawBody : rawBody.toString("utf8")}`;
  const signature = createHmac("sha256", secret).update(payload).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

interface StripeProviderOptions {
  toleranceSeconds?: number;
  now?: () => number; // epoch 秒；测试可注入以固定容差判定。
}

// Stripe webhook 验签：HMAC-SHA256(secret, `${t}.${rawBody}`)，容差窗口内比对任一 v1。
export class StripeWebhookProvider implements PaymentWebhookProvider {
  readonly kind = "stripe" as const;
  private readonly toleranceSeconds: number;
  private readonly now: () => number;

  constructor(options: StripeProviderOptions = {}) {
    this.toleranceSeconds = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  verifySignature(headers: IncomingHttpHeaders, rawBody: Buffer, secret: string): boolean {
    const raw = headers[STRIPE_SIGNATURE_HEADER];
    const header = Array.isArray(raw) ? raw[0] : raw;
    if (!header) {
      return false;
    }
    let timestamp: number | null = null;
    const signatures: string[] = [];
    for (const part of header.split(",")) {
      const [key, value] = part.split("=", 2);
      if (key === "t" && value) {
        timestamp = Number(value);
      } else if (key === "v1" && value) {
        signatures.push(value);
      }
    }
    if (timestamp === null || !Number.isFinite(timestamp) || signatures.length === 0) {
      return false;
    }
    // 时间戳容差：拒绝窗口外的回放。
    if (Math.abs(this.now() - timestamp) > this.toleranceSeconds) {
      return false;
    }
    const expected = Buffer.from(
      createHmac("sha256", secret).update(`${timestamp}.${rawBody.toString("utf8")}`).digest("hex"),
      "utf8",
    );
    return signatures.some((candidate) => {
      const provided = Buffer.from(candidate, "utf8");
      return provided.length === expected.length && timingSafeEqual(provided, expected);
    });
  }

  parseEvent(payload: unknown): ParsedWebhookEvent {
    const parsed = stripeEventSchema.safeParse(payload);
    if (!parsed.success) {
      throw new WebhookError(
        "payment.webhook_payload_invalid",
        "stripe webhook payload is invalid: expected { id, type, data }",
        400,
      );
    }
    const { id, type } = parsed.data;
    const object = parsed.data.data?.object;
    const metadata = webhookMetadataSchema.parse(object?.metadata ?? {});

    if (type === "payment_intent.succeeded" || type === "checkout.session.completed") {
      return { eventId: id, eventType: WEBHOOK_EVENT.paymentSucceeded, orderId: metadata.orderId ?? null, subscription: null };
    }
    if (type === "charge.refunded") {
      return { eventId: id, eventType: WEBHOOK_EVENT.refundSucceeded, orderId: metadata.orderId ?? null, subscription: null };
    }
    if (type.startsWith("customer.subscription.")) {
      const { status, grantCredits } =
        type === "customer.subscription.deleted"
          ? { status: "canceled" as const, grantCredits: false }
          : mapSubscriptionStatus(object?.status);
      const subscription = buildSubscriptionEvent({
        metadata,
        providerSubscriptionId: object?.id ?? id,
        status,
        currentPeriodStart: unixSecondsToDate(object?.current_period_start),
        currentPeriodEnd: unixSecondsToDate(object?.current_period_end),
        grantCredits,
      });
      return { eventId: id, eventType: WEBHOOK_EVENT.subscriptionUpdated, orderId: null, subscription };
    }
    // 未订阅的事件类型：ack（eventType 保持原样，process 走默认分支不产生副作用）。
    return { eventId: id, eventType: type, orderId: null, subscription: null };
  }
}
