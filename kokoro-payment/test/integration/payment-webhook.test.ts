import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPaymentServer } from "../../src/interfaces/http/server.js";
import {
  cleanPaymentDatabase,
  createTestPrismaClient,
  paymentReadCapabilities,
} from "./helpers.js";

const prisma = createTestPrismaClient();
const app = createPaymentServer({ readCapabilities: paymentReadCapabilities(prisma) });

describe("provider ingress is inert during redeem-only launch (real mysql)", () => {
  beforeEach(async () => {
    await cleanPaymentDatabase(prisma);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it.each([
    ["application/json", JSON.stringify({ id: "evt-json", type: "payment_succeeded" })],
    ["application/x-www-form-urlencoded", "trade_status=TRADE_SUCCESS&out_trade_no=order-1"],
    ["application/octet-stream", "opaque-provider-payload"],
  ] as const)("returns one disabled envelope for %s without recording events", async (contentType, payload) => {
    const response = await app.inject({
      method: "POST",
      url: "/payments/webhooks/provider-any",
      headers: { "content-type": contentType },
      payload,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("ACQUISITION_CHANNEL_DISABLED");
    expect(await prisma.paymentEvent.count()).toBe(0);
    expect(await prisma.order.count()).toBe(0);
  });

  it.each([
    ["POST", "/admin/payments/providers/upsert"],
    ["DELETE", "/admin/payments/providers/mock"],
    ["POST", "/admin/payments/events/event-1/replay"],
  ] as const)("does not register provider mutation %s %s", async (method, url) => {
    const response = await app.inject({ method, url, payload: {} });
    expect(response.statusCode).toBe(404);
    expect(await prisma.paymentProvider.count()).toBe(0);
    expect(await prisma.paymentEvent.count()).toBe(0);
  });
});
