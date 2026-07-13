import { z } from "zod";
import type { ParsedSubscriptionEvent } from "../../domain/webhook.js";
import type { SubscriptionStatus } from "../../domain/payment.js";

// 我方在下单/开通时挂到各网关 metadata 位上的业务标识约定（web 购买流批注入）：
// stripe=data.object.metadata / alipay=passback_params / wechat=attach。
// passthrough 容忍网关回填的额外字段。
export const webhookMetadataSchema = z
  .object({
    orderId: z.string().min(1).optional(),
    teamId: z.string().min(1).optional(),
    planId: z.string().min(1).optional(),
  })
  .passthrough();

export type WebhookMetadata = z.infer<typeof webhookMetadataSchema>;

// unix 秒（string|number）→ Date；缺失或非法返回 null（周期未知不阻断状态推进）。
export function unixSecondsToDate(value: unknown): Date | null {
  const seconds = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  return new Date(seconds * 1000);
}

// 由 metadata（teamId/planId）+ 事件自带的订阅态/周期，装配归一化订阅事件。
// teamId/planId 缺失时返回 null：process 会据此把事件标 failed（fail-loud，不静默建残缺订阅行）。
export function buildSubscriptionEvent(input: {
  metadata: WebhookMetadata;
  providerSubscriptionId: string;
  status: SubscriptionStatus;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  grantCredits: boolean;
}): ParsedSubscriptionEvent | null {
  if (!input.metadata.teamId || !input.metadata.planId) {
    return null;
  }
  return {
    providerSubscriptionId: input.providerSubscriptionId,
    teamId: input.metadata.teamId,
    planId: input.metadata.planId,
    status: input.status,
    currentPeriodStart: input.currentPeriodStart,
    currentPeriodEnd: input.currentPeriodEnd,
    grantCredits: input.grantCredits,
  };
}
