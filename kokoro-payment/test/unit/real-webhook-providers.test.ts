import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WEBHOOK_EVENT } from "../../src/domain/webhook.js";
import {
  STRIPE_SIGNATURE_HEADER,
  StripeWebhookProvider,
  signStripeWebhook,
} from "../../src/infrastructure/webhook/stripe-webhook-provider.js";
import {
  AlipayWebhookProvider,
  signAlipayNotification,
} from "../../src/infrastructure/webhook/alipay-webhook-provider.js";
import {
  WECHAT_NONCE_HEADER,
  WECHAT_SIGNATURE_HEADER,
  WECHAT_TIMESTAMP_HEADER,
  WechatWebhookProvider,
  signWechatNotification,
} from "../../src/infrastructure/webhook/wechat-webhook-provider.js";

// 自签 RSA 密钥对（测试向量专用，非真实凭据）。
function rsaKeyPair(): { publicKey: string; privateKey: string } {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

describe("StripeWebhookProvider signature", () => {
  const secret = "whsec_example-token";
  const now = 1_700_000_000;
  const provider = new StripeWebhookProvider({ now: () => now });

  it("accepts a valid t/v1 signature within tolerance", () => {
    const body = Buffer.from(JSON.stringify({ id: "evt_1", type: "payment_intent.succeeded" }));
    const header = signStripeWebhook(body, secret, now);
    expect(provider.verifySignature({ [STRIPE_SIGNATURE_HEADER]: header }, body, secret)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const body = Buffer.from(JSON.stringify({ id: "evt_1", type: "payment_intent.succeeded" }));
    const header = signStripeWebhook(body, secret, now);
    const tampered = Buffer.from(JSON.stringify({ id: "evt_1", type: "charge.refunded" }));
    expect(provider.verifySignature({ [STRIPE_SIGNATURE_HEADER]: header }, tampered, secret)).toBe(false);
  });

  it("rejects the wrong secret", () => {
    const body = Buffer.from("{}");
    const header = signStripeWebhook(body, secret, now);
    expect(provider.verifySignature({ [STRIPE_SIGNATURE_HEADER]: header }, body, "whsec_other")).toBe(false);
  });

  it("rejects a timestamp outside the tolerance window (replay)", () => {
    const body = Buffer.from("{}");
    const header = signStripeWebhook(body, secret, now - 3600);
    expect(provider.verifySignature({ [STRIPE_SIGNATURE_HEADER]: header }, body, secret)).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(provider.verifySignature({}, Buffer.from("{}"), secret)).toBe(false);
  });

  it("normalizes payment / refund / subscription events", () => {
    const paid = provider.parseEvent({
      id: "evt_p",
      type: "payment_intent.succeeded",
      data: { object: { metadata: { orderId: "order_9" } } },
    });
    expect(paid).toMatchObject({ eventType: WEBHOOK_EVENT.paymentSucceeded, orderId: "order_9" });

    const refunded = provider.parseEvent({
      id: "evt_r",
      type: "charge.refunded",
      data: { object: { metadata: { orderId: "order_9" } } },
    });
    expect(refunded).toMatchObject({ eventType: WEBHOOK_EVENT.refundSucceeded, orderId: "order_9" });

    const sub = provider.parseEvent({
      id: "evt_s",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_x",
          status: "active",
          current_period_start: 1_700_000_000,
          metadata: { teamId: "team_1", planId: "plan_1" },
        },
      },
    });
    expect(sub.eventType).toBe(WEBHOOK_EVENT.subscriptionUpdated);
    expect(sub.subscription).toMatchObject({
      providerSubscriptionId: "sub_x",
      teamId: "team_1",
      planId: "plan_1",
      status: "active",
      grantCredits: true,
    });
    expect(sub.subscription?.currentPeriodStart?.toISOString()).toBe("2023-11-14T22:13:20.000Z");
  });

  it("subscription event without team/plan metadata yields null (process fails loud)", () => {
    const sub = provider.parseEvent({
      id: "evt_s2",
      type: "customer.subscription.updated",
      data: { object: { id: "sub_y", status: "active" } },
    });
    expect(sub.subscription).toBeNull();
  });
});

describe("AlipayWebhookProvider signature", () => {
  const { publicKey, privateKey } = rsaKeyPair();
  const provider = new AlipayWebhookProvider();

  function formBody(params: Record<string, string>): Buffer {
    return Buffer.from(new URLSearchParams(params).toString());
  }

  it("accepts a valid RSA2 notification and rejects a tampered one", () => {
    const params: Record<string, string> = {
      notify_id: "notif_1",
      trade_status: "TRADE_SUCCESS",
      out_trade_no: "order_5",
      passback_params: JSON.stringify({ orderId: "order_5" }),
      sign_type: "RSA2",
    };
    params.sign = signAlipayNotification(params, privateKey);

    expect(provider.verifySignature({}, formBody(params), publicKey)).toBe(true);

    const tampered = { ...params, out_trade_no: "order_6" };
    expect(provider.verifySignature({}, formBody(tampered), publicKey)).toBe(false);
  });

  it("rejects a non-RSA2 sign_type", () => {
    const params: Record<string, string> = { notify_id: "n", trade_status: "TRADE_SUCCESS", sign_type: "RSA" };
    params.sign = signAlipayNotification(params, privateKey);
    expect(provider.verifySignature({}, formBody(params), publicKey)).toBe(false);
  });

  it("decodes form body and normalizes trade_status / refund", () => {
    const paid = provider.parseEvent(
      provider.decodeBody(
        formBody({ notify_id: "n1", trade_status: "TRADE_SUCCESS", out_trade_no: "order_7" }),
      ),
    );
    expect(paid).toMatchObject({ eventType: WEBHOOK_EVENT.paymentSucceeded, orderId: "order_7" });

    const refund = provider.parseEvent(
      provider.decodeBody(
        formBody({ notify_id: "n2", trade_status: "TRADE_SUCCESS", refund_fee: "49.00", out_trade_no: "order_7" }),
      ),
    );
    expect(refund.eventType).toBe(WEBHOOK_EVENT.refundSucceeded);
  });
});

describe("WechatWebhookProvider signature", () => {
  const { publicKey, privateKey } = rsaKeyPair();
  const now = 1_700_000_000;
  const provider = new WechatWebhookProvider({ now: () => now });

  function headers(timestamp: string, nonce: string, body: Buffer) {
    return {
      [WECHAT_TIMESTAMP_HEADER]: timestamp,
      [WECHAT_NONCE_HEADER]: nonce,
      [WECHAT_SIGNATURE_HEADER]: signWechatNotification(timestamp, nonce, body, privateKey),
    };
  }

  it("accepts a valid APIv3 signature and rejects tamper / wrong key", () => {
    const body = Buffer.from(JSON.stringify({ id: "evt_w", event_type: "TRANSACTION.SUCCESS" }));
    const ts = String(now);
    expect(provider.verifySignature(headers(ts, "nonce1", body), body, publicKey)).toBe(true);

    const tampered = Buffer.from(JSON.stringify({ id: "evt_w", event_type: "REFUND.SUCCESS" }));
    expect(provider.verifySignature(headers(ts, "nonce1", body), tampered, publicKey)).toBe(false);

    const otherKey = rsaKeyPair().publicKey;
    expect(provider.verifySignature(headers(ts, "nonce1", body), body, otherKey)).toBe(false);
  });

  it("rejects a stale timestamp (replay window)", () => {
    const body = Buffer.from("{}");
    const ts = String(now - 3600);
    expect(provider.verifySignature(headers(ts, "nonce1", body), body, publicKey)).toBe(false);
  });

  it("normalizes transaction / refund event types", () => {
    const paid = provider.parseEvent({
      id: "evt_w",
      event_type: "TRANSACTION.SUCCESS",
      resource: { out_trade_no: "order_8" },
    });
    expect(paid).toMatchObject({ eventType: WEBHOOK_EVENT.paymentSucceeded, orderId: "order_8" });

    const refund = provider.parseEvent({ id: "evt_w2", event_type: "REFUND.SUCCESS", resource: { out_trade_no: "order_8" } });
    expect(refund.eventType).toBe(WEBHOOK_EVENT.refundSucceeded);
  });
});
