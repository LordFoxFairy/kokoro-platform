import { createSign, createVerify } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { z } from "zod";
import type { ParsedWebhookEvent, PaymentWebhookProvider } from "../../domain/webhook.js";
import { WEBHOOK_EVENT, WebhookError } from "../../domain/webhook.js";
import { webhookMetadataSchema } from "./normalize.js";

const alipayParamsSchema = z.record(z.string(), z.string());

// 排除 sign / sign_type 与空值，按 key 升序拼 `k=v&...`——Alipay 异步通知 RSA2 验签的待签内容。
export function buildAlipaySignContent(params: Record<string, string>): string {
  return Object.keys(params)
    .filter((key) => key !== "sign" && key !== "sign_type" && params[key] !== "")
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
}

// 测试向量：给定私钥对表单参数按 Alipay 口径签名（RSA-SHA256/base64）。
export function signAlipayNotification(
  params: Record<string, string>,
  privateKeyPem: string,
): string {
  const signer = createSign("RSA-SHA256");
  signer.update(buildAlipaySignContent(params), "utf8");
  signer.end();
  return signer.sign(privateKeyPem, "base64");
}

// passback_params 里我方回填的业务标识（JSON 字符串）；解析失败则视作空 metadata。
function readPassback(params: Record<string, string>): z.infer<typeof webhookMetadataSchema> {
  const raw = params.passback_params;
  if (!raw) {
    return webhookMetadataSchema.parse({});
  }
  try {
    return webhookMetadataSchema.parse(JSON.parse(raw));
  } catch {
    return webhookMetadataSchema.parse({});
  }
}

// Alipay 异步通知验签：body 为 x-www-form-urlencoded，RSA2(RSA-SHA256) 用 Alipay 公钥验签。
// secret = Alipay 平台公钥 PEM。
export class AlipayWebhookProvider implements PaymentWebhookProvider {
  readonly kind = "alipay" as const;

  decodeBody(rawBody: Buffer): unknown {
    const params: Record<string, string> = {};
    for (const [key, value] of new URLSearchParams(rawBody.toString("utf8"))) {
      params[key] = value;
    }
    return params;
  }

  verifySignature(_headers: IncomingHttpHeaders, rawBody: Buffer, secret: string): boolean {
    const parsed = alipayParamsSchema.safeParse(this.decodeBody(rawBody));
    if (!parsed.success) {
      return false;
    }
    const params = parsed.data;
    const sign = params.sign;
    if (!sign || params.sign_type !== "RSA2") {
      return false;
    }
    const content = buildAlipaySignContent(params);
    try {
      const verifier = createVerify("RSA-SHA256");
      verifier.update(content, "utf8");
      verifier.end();
      return verifier.verify(secret, sign, "base64");
    } catch {
      return false;
    }
  }

  parseEvent(payload: unknown): ParsedWebhookEvent {
    const parsed = alipayParamsSchema.safeParse(payload);
    if (!parsed.success) {
      throw new WebhookError(
        "payment.webhook_payload_invalid",
        "alipay notification payload is invalid: expected form-encoded params",
        400,
      );
    }
    const params = parsed.data;
    const eventId = params.notify_id;
    if (!eventId) {
      throw new WebhookError(
        "payment.webhook_payload_invalid",
        "alipay notification is missing notify_id",
        400,
      );
    }
    const metadata = readPassback(params);
    const orderId = metadata.orderId ?? params.out_trade_no ?? null;

    // 退款异步通知带 refund_fee；否则按交易状态判定支付成功。
    if (params.refund_fee) {
      return { eventId, eventType: WEBHOOK_EVENT.refundSucceeded, orderId, subscription: null };
    }
    if (params.trade_status === "TRADE_SUCCESS" || params.trade_status === "TRADE_FINISHED") {
      return { eventId, eventType: WEBHOOK_EVENT.paymentSucceeded, orderId, subscription: null };
    }
    // 其余状态（WAIT_BUYER_PAY/TRADE_CLOSED 等）ack，不产生订单副作用。
    return { eventId, eventType: params.trade_status ?? "unknown", orderId: null, subscription: null };
  }
}
