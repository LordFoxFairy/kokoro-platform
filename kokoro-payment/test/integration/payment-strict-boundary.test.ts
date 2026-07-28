import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPaymentServer } from "../../src/interfaces/http/server.js";
import {
  cleanPaymentDatabase,
  createTestPrismaClient,
  paymentReadCapabilities,
  siteHeaders,
} from "./helpers.js";

const prisma = createTestPrismaClient();
const app = createPaymentServer({ readCapabilities: paymentReadCapabilities(prisma) });

describe("disabled acquisition rejects before payload interpretation (real mysql)", () => {
  beforeEach(() => cleanPaymentDatabase(prisma));
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it.each([
    ["/orders", { bogus: 1 }],
    ["/orders/order-1/confirm", { unexpected: true }],
    ["/payment-events/record", { nested: { arbitrary: [1, 2, 3] } }],
  ] as const)("returns the stable shutdown envelope for malformed POST %s", async (url, payload) => {
    const response = await app.inject({ method: "POST", url, headers: siteHeaders, payload });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("ACQUISITION_CHANNEL_DISABLED");
    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.paymentEvent.count()).toBe(0);
  });

  it("keeps plan mutation structurally absent rather than interpreting its payload", async () => {
    const response = await app.inject({ method: "POST", url: "/plans/upsert", headers: siteHeaders, payload: { bogus: 1 } });
    expect(response.statusCode).toBe(404);
    expect(await prisma.plan.count()).toBe(0);
  });
});
