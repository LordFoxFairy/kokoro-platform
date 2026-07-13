import { createSign, createVerify } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { z } from "zod";
import type { ParsedWebhookEvent, PaymentWebhookProvider } from "../../domain/webhook.js";
import { WEBHOOK_EVENT, WebhookError } from "../../domain/webhook.js";
import { webhookMetadataSchema } from "./normalize.js";

export const WECHAT_TIMESTAMP_HEADER = "wechatpay-timestamp";
export const WECHAT_NONCE_HEADER = "wechatpay-nonce";
export const WECHAT_SIGNATURE_HEADER = "wechatpay-signature";
const DEFAULT_TOLERANCE_SECONDS = 300;

// APIv3 通知信封。resource 在真实网关是 AEAD_AES_256_GCM 密文，其解密需独立 APIv3 对称密钥，
// 不在本单一 secret 模型内——本 provider 只做「平台证书验签」，订单联动的 resource 解密留后续。
// resource 里若已带明文 metadata/out_trade_no（预解密或测试），parseEvent 会消费。
const wechatEventSchema = z
  .object({
    id: z.string().min(1),
    event_type: z.string().min(1),
    resource: z
      .object({
        out_trade_no: z.string().optional(),
        metadata: webhookMetadataSchema.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const raw = headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

// WeChat APIv3 待签串：`${timestamp}\n${nonce}\n${body}\n`。
function buildSignContent(timestamp: string, nonce: string, body: string): string {
  return `${timestamp}\n${nonce}\n${body}\n`;
}

// 测试向量：用私钥对 APIv3 待签串签名（RSA-SHA256/base64）。
export function signWechatNotification(
  timestamp: string,
  nonce: string,
  rawBody: Buffer | string,
  privateKeyPem: string,
): string {
  const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const signer = createSign("RSA-SHA256");
  signer.update(buildSignContent(timestamp, nonce, body), "utf8");
  signer.end();
  return signer.sign(privateKeyPem, "base64");
}

interface WechatProviderOptions {
  toleranceSeconds?: number;
  now?: () => number; // epoch 秒。
}

// WeChat APIv3 验签：RSA-SHA256(平台证书公钥) over `${ts}\n${nonce}\n${body}\n`，含时间戳容差。
// secret = WeChat 平台证书公钥 PEM。
export class WechatWebhookProvider implements PaymentWebhookProvider {
  readonly kind = "wechat" as const;
  private readonly toleranceSeconds: number;
  private readonly now: () => number;

  constructor(options: WechatProviderOptions = {}) {
    this.toleranceSeconds = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  verifySignature(headers: IncomingHttpHeaders, rawBody: Buffer, secret: string): boolean {
    const timestamp = headerValue(headers, WECHAT_TIMESTAMP_HEADER);
    const nonce = headerValue(headers, WECHAT_NONCE_HEADER);
    const signature = headerValue(headers, WECHAT_SIGNATURE_HEADER);
    if (!timestamp || !nonce || !signature) {
      return false;
    }
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(this.now() - ts) > this.toleranceSeconds) {
      return false;
    }
    try {
      const verifier = createVerify("RSA-SHA256");
      verifier.update(buildSignContent(timestamp, nonce, rawBody.toString("utf8")), "utf8");
      verifier.end();
      return verifier.verify(secret, signature, "base64");
    } catch {
      return false;
    }
  }

  parseEvent(payload: unknown): ParsedWebhookEvent {
    const parsed = wechatEventSchema.safeParse(payload);
    if (!parsed.success) {
      throw new WebhookError(
        "payment.webhook_payload_invalid",
        "wechat notification payload is invalid: expected { id, event_type }",
        400,
      );
    }
    const { id, event_type } = parsed.data;
    const resource = parsed.data.resource;
    const metadata = webhookMetadataSchema.parse(resource?.metadata ?? {});
    const orderId = metadata.orderId ?? resource?.out_trade_no ?? null;

    if (event_type === "TRANSACTION.SUCCESS") {
      return { eventId: id, eventType: WEBHOOK_EVENT.paymentSucceeded, orderId, subscription: null };
    }
    if (event_type === "REFUND.SUCCESS") {
      return { eventId: id, eventType: WEBHOOK_EVENT.refundSucceeded, orderId, subscription: null };
    }
    return { eventId: id, eventType: event_type, orderId: null, subscription: null };
  }
}
