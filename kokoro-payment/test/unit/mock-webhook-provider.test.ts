import { describe, expect, it } from "vitest";
import { WebhookError } from "../../src/domain/webhook.js";
import {
  MOCK_WEBHOOK_SIGNATURE_HEADER,
  MockWebhookProvider,
  signMockWebhook,
} from "../../src/infrastructure/webhook/mock-webhook-provider.js";

const provider = new MockWebhookProvider();
const secret = "example-token";
const body = Buffer.from(JSON.stringify({ eventId: "evt_1", eventType: "payment_succeeded" }));

describe("MockWebhookProvider verifySignature", () => {
  it("accepts a valid HMAC-SHA256 signature over the raw body", () => {
    const headers = { [MOCK_WEBHOOK_SIGNATURE_HEADER]: signMockWebhook(body, secret) };
    expect(provider.verifySignature(headers, body, secret)).toBe(true);
  });

  it("rejects a missing signature header", () => {
    expect(provider.verifySignature({}, body, secret)).toBe(false);
  });

  it("rejects an empty signature header", () => {
    expect(provider.verifySignature({ [MOCK_WEBHOOK_SIGNATURE_HEADER]: "" }, body, secret)).toBe(false);
  });

  it("rejects a signature computed with a different secret", () => {
    const headers = { [MOCK_WEBHOOK_SIGNATURE_HEADER]: signMockWebhook(body, "wrong-secret") };
    expect(provider.verifySignature(headers, body, secret)).toBe(false);
  });

  it("rejects a signature over different bytes", () => {
    const headers = { [MOCK_WEBHOOK_SIGNATURE_HEADER]: signMockWebhook(Buffer.from("{}"), secret) };
    expect(provider.verifySignature(headers, body, secret)).toBe(false);
  });

  it("rejects a truncated signature without throwing (length mismatch)", () => {
    const truncated = signMockWebhook(body, secret).slice(0, 10);
    expect(provider.verifySignature({ [MOCK_WEBHOOK_SIGNATURE_HEADER]: truncated }, body, secret)).toBe(false);
  });

  it("uses the first value when the header arrives as an array", () => {
    const headers = { [MOCK_WEBHOOK_SIGNATURE_HEADER]: [signMockWebhook(body, secret), "bogus"] };
    expect(provider.verifySignature(headers, body, secret)).toBe(true);
  });
});

describe("MockWebhookProvider parseEvent", () => {
  it("extracts eventId/eventType/orderId from the envelope", () => {
    const parsed = provider.parseEvent({
      eventId: "evt_1",
      eventType: "payment_succeeded",
      data: { orderId: "order_1", extra: "ok" },
      vendorField: 1,
    });
    expect(parsed).toEqual({
      eventId: "evt_1",
      eventType: "payment_succeeded",
      orderId: "order_1",
      subscription: null,
    });
  });

  it("returns orderId null when data.orderId is absent", () => {
    const parsed = provider.parseEvent({ eventId: "evt_2", eventType: "ping" });
    expect(parsed).toEqual({ eventId: "evt_2", eventType: "ping", orderId: null, subscription: null });
  });

  it.each([null, "text", 42, {}, { eventId: "evt_x" }, { eventId: "", eventType: "t" }])(
    "throws a 400 WebhookError for invalid payload %j",
    (payload) => {
      try {
        provider.parseEvent(payload);
        expect.unreachable("parseEvent should throw");
      } catch (error) {
        expect(error).toBeInstanceOf(WebhookError);
        expect((error as WebhookError).statusCode).toBe(400);
        expect((error as WebhookError).code).toBe("payment.webhook_payload_invalid");
      }
    },
  );
});
