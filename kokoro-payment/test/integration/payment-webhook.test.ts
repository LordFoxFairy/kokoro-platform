import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPaymentServer } from "../../src/interfaces/http/server.js";
import {
  MOCK_WEBHOOK_SIGNATURE_HEADER,
  signMockWebhook,
} from "../../src/infrastructure/webhook/mock-webhook-provider.js";
import type { GrantPurchaseCreditsInput } from "../../src/domain/repository.js";
import {
  TEST_SITE_ID,
  cleanPaymentDatabase,
  createTestPrismaClient,
  recordingReverse,
} from "./helpers.js";

const SECRET_ENV = "KOKORO_PAYMENT_WEBHOOK_SECRET_MOCK_ITEST";
const SECRET = "example-token";
process.env[SECRET_ENV] = SECRET;

const prisma = createTestPrismaClient();
const grants: GrantPurchaseCreditsInput[] = [];
// 可开关的故障注入：模拟 credit 侧不可用，制造 failed 事件供手动重放验证。
let grantFails = false;
const app = createPaymentServer({
  prisma,
  grantPurchaseCredits: async (input) => {
    if (grantFails) {
      throw new Error("credit grant unavailable");
    }
    grants.push(input);
  },
  reverseCredits: recordingReverse().reverseCredits,
  // 不注入 webhookSecretResolver：走默认 process.env 解析，验证 env 引用真实链路。
});

async function seedProvider(overrides: Record<string, unknown> = {}): Promise<void> {
  const response = await app.inject({
    method: "POST",
    url: "/admin/payments/providers/upsert",
    payload: {
      key: "mockpay",
      kind: "mock",
      webhookSecretRef: SECRET_ENV,
      enabled: true,
      ...overrides,
    },
  });
  expect(response.statusCode).toBe(200);
}

async function seedPaidableOrder(idempotencyKey: string) {
  const plan = await prisma.plan.create({
    data: {
      siteId: TEST_SITE_ID,
      key: `webhook_plan_${idempotencyKey}`,
      name: "Webhook Plan",
      currency: "USD",
      amountMinor: 4900n,
      creditMicros: 1_000_000n,
      billingInterval: "month",
      status: "active",
    },
  });
  return prisma.order.create({
    data: {
      siteId: TEST_SITE_ID,
      teamId: "team_webhook",
      planId: plan.id,
      amountMinor: 4900n,
      currency: "USD",
      idempotencyKey,
      status: "pending",
    },
  });
}

function postWebhook(provider: string, body: string, headers: Record<string, string> = {}) {
  return app.inject({
    method: "POST",
    url: `/payments/webhooks/${provider}`,
    headers: { "content-type": "application/json", ...headers },
    payload: body,
  });
}

function signedPost(provider: string, body: string) {
  return postWebhook(provider, body, {
    [MOCK_WEBHOOK_SIGNATURE_HEADER]: signMockWebhook(body, SECRET),
  });
}

describe("payment webhook surface (real mysql)", () => {
  beforeEach(async () => {
    await cleanPaymentDatabase(prisma);
    grants.length = 0;
    grantFails = false;
  });

  afterAll(async () => {
    delete process.env[SECRET_ENV];
    await app.close();
    await prisma.$disconnect();
  });

  it("admin provider CRUD: upsert, list, update, delete", async () => {
    await seedProvider();

    const listed = await app.inject({ method: "GET", url: "/admin/payments/providers" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().data).toHaveLength(1);
    expect(listed.json().data[0]).toMatchObject({
      key: "mockpay",
      kind: "mock",
      webhookSecretRef: SECRET_ENV,
      enabled: true,
    });

    await seedProvider({ enabled: false });
    const relisted = await app.inject({ method: "GET", url: "/admin/payments/providers" });
    expect(relisted.json().data).toHaveLength(1);
    expect(relisted.json().data[0].enabled).toBe(false);

    const deleted = await app.inject({ method: "DELETE", url: "/admin/payments/providers/mockpay" });
    expect(deleted.statusCode).toBe(200);
    const emptied = await app.inject({ method: "GET", url: "/admin/payments/providers" });
    expect(emptied.json().data).toEqual([]);
  });

  it("provider upsert rejects a plaintext-looking secret (must be an env name)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/admin/payments/providers/upsert",
      payload: { key: "mockpay", kind: "mock", webhookSecretRef: "whsec_51H8xLkE2eZvKYlo2C" },
    });
    expect(response.statusCode).toBe(400);
    const providers = await prisma.paymentProvider.findMany();
    expect(providers).toEqual([]);
  });

  it("provider delete returns 404 for an unknown key", async () => {
    const response = await app.inject({ method: "DELETE", url: "/admin/payments/providers/ghost" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("payment.provider_not_found");
  });

  it("verified payment_succeeded webhook confirms the order and lands processed", async () => {
    await seedProvider();
    const order = await seedPaidableOrder("webhook_happy");
    const body = JSON.stringify({
      eventId: "evt_happy",
      eventType: "payment_succeeded",
      data: { orderId: order.id },
    });

    const response = await signedPost("mockpay", body);

    expect(response.statusCode).toBe(200);
    const receipt = response.json().data as {
      duplicate: boolean;
      event: { status: string; lastError: string | null };
    };
    expect(receipt.duplicate).toBe(false);
    expect(receipt.event.status).toBe("processed");
    expect(receipt.event.lastError).toBeNull();

    const storedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(storedOrder.status).toBe("paid");
    expect(grants).toHaveLength(1);
    expect(grants[0]?.idempotencyKey).toBe(`order:${order.id}`);

    const storedEvent = await prisma.paymentEvent.findUniqueOrThrow({
      where: { provider_eventId: { provider: "mockpay", eventId: "evt_happy" } },
    });
    expect(storedEvent.status).toBe("processed");
  });

  it("replayed webhook delivery is idempotent: one event row, one grant, still 200", async () => {
    await seedProvider();
    const order = await seedPaidableOrder("webhook_replay");
    const body = JSON.stringify({
      eventId: "evt_replay",
      eventType: "payment_succeeded",
      data: { orderId: order.id },
    });

    const first = await signedPost("mockpay", body);
    const second = await signedPost("mockpay", body);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().data.duplicate).toBe(true);
    expect(second.json().data.event.status).toBe("processed");
    expect(grants).toHaveLength(1);
    const events = await prisma.paymentEvent.findMany({ where: { eventId: "evt_replay" } });
    expect(events).toHaveLength(1);
  });

  it("rejects a tampered signature with 401 and records nothing", async () => {
    await seedProvider();
    const body = JSON.stringify({ eventId: "evt_bad_sig", eventType: "payment_succeeded" });
    const response = await postWebhook("mockpay", body, {
      [MOCK_WEBHOOK_SIGNATURE_HEADER]: signMockWebhook(body, "wrong-secret"),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("payment.webhook_signature_invalid");
    expect(await prisma.paymentEvent.count()).toBe(0);
  });

  it("rejects a missing signature header with 401", async () => {
    await seedProvider();
    const response = await postWebhook("mockpay", JSON.stringify({ eventId: "e", eventType: "t" }));
    expect(response.statusCode).toBe(401);
  });

  it("returns 404 for unknown and disabled providers alike", async () => {
    const unknown = await signedPost("ghost", JSON.stringify({ eventId: "e", eventType: "t" }));
    expect(unknown.statusCode).toBe(404);

    await seedProvider({ enabled: false });
    const disabled = await signedPost("mockpay", JSON.stringify({ eventId: "e", eventType: "t" }));
    expect(disabled.statusCode).toBe(404);
    expect(disabled.json().error.code).toBe("payment.webhook_provider_unknown");
  });

  it("returns 501 for a configured provider kind whose verifier is not implemented", async () => {
    await seedProvider({ key: "stripe_main", kind: "stripe", webhookSecretRef: "STRIPE_WEBHOOK_SECRET" });
    const response = await signedPost("stripe_main", JSON.stringify({ eventId: "e", eventType: "t" }));
    expect(response.statusCode).toBe(501);
    expect(response.json().error.code).toBe("payment.webhook_provider_not_implemented");
  });

  it("fails closed with 500 when the secret env ref is not set", async () => {
    await seedProvider({ webhookSecretRef: "KOKORO_PAYMENT_WEBHOOK_SECRET_DANGLING" });
    const response = await signedPost("mockpay", JSON.stringify({ eventId: "e", eventType: "t" }));
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe("payment.webhook_secret_unavailable");
  });

  it("failed event carries lastError and manual replay drives it to processed", async () => {
    await seedProvider();
    const order = await seedPaidableOrder("webhook_retry");
    const body = JSON.stringify({
      eventId: "evt_retry",
      eventType: "payment_succeeded",
      data: { orderId: order.id },
    });

    grantFails = true;
    const failedResponse = await signedPost("mockpay", body);
    expect(failedResponse.statusCode).toBe(200);
    expect(failedResponse.json().data.event.status).toBe("failed");
    expect(failedResponse.json().data.event.lastError).toContain("credit grant unavailable");
    const eventId = failedResponse.json().data.event.id as string;

    // 处理失败不吞掉订单确认意图：order 停在 confirming，重放沿同一幂等键收尾。
    grantFails = false;
    const replay = await app.inject({ method: "POST", url: `/admin/payments/events/${eventId}/replay` });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.status).toBe("processed");
    expect(replay.json().data.lastError).toBeNull();

    const storedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(storedOrder.status).toBe("paid");
    expect(grants).toHaveLength(1);

    // 再次重放已 processed 的事件：幂等返回，不再发积分。
    const again = await app.inject({ method: "POST", url: `/admin/payments/events/${eventId}/replay` });
    expect(again.statusCode).toBe(200);
    expect(again.json().data.status).toBe("processed");
    expect(grants).toHaveLength(1);
  });

  it("replay returns 404 for an unknown event id", async () => {
    const response = await app.inject({ method: "POST", url: "/admin/payments/events/evt_ghost/replay" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("payment.event_not_found");
  });

  it("rejects a signed but malformed JSON body with 400 and records nothing", async () => {
    await seedProvider();
    const body = "not json";
    const response = await postWebhook("mockpay", body, {
      [MOCK_WEBHOOK_SIGNATURE_HEADER]: signMockWebhook(body, SECRET),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("payment.webhook_payload_invalid");
    expect(await prisma.paymentEvent.count()).toBe(0);
  });
});
