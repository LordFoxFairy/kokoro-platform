import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaPaymentRepository } from "../../src/infrastructure/prisma/prisma-payment-repository.js";
import { createPaymentServer } from "../../src/interfaces/http/server.js";
import {
  cleanPaymentDatabase,
  createTestPrismaClient,
  paymentReadCapabilities,
  siteHeaders,
} from "./helpers.js";

const prisma = createTestPrismaClient();
const repository = new PrismaPaymentRepository(prisma);
const app = createPaymentServer({ readCapabilities: paymentReadCapabilities(prisma) });

describe("payment disabled error paths (real mysql)", () => {
  beforeEach(() => cleanPaymentDatabase(prisma));
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it.each([
    "/orders/sweep",
    "/orders/order-canceled/confirm",
    "/orders/order-paid/refund",
  ])("returns stable disabled semantics independent of stored state for POST %s", async (url) => {
    const response = await app.inject({ method: "POST", url, headers: siteHeaders, payload: {} });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("ACQUISITION_CHANNEL_DISABLED");
    expect(await prisma.order.count()).toBe(0);
  });

  it.each([
    ["DELETE", "/plans/plan-ghost"],
    ["POST", "/plans/plan-ghost/restore"],
  ] as const)("keeps plan mutation absent for %s %s", async (method, url) => {
    expect((await app.inject({ method, url, payload: {} })).statusCode).toBe(404);
    expect(await prisma.plan.count()).toBe(0);
  });
});

describe("PrismaPaymentRepository event transition retained for migration (real mysql)", () => {
  beforeEach(() => cleanPaymentDatabase(prisma));

  it("conditional transition loser cannot overwrite the winner", async () => {
    const event = await repository.recordPaymentEvent({
      provider: "legacy",
      eventId: "evt-transition",
      eventType: "payment_succeeded",
      payload: { orderId: "order-x" },
    });
    const winner = await repository.transitionPaymentEventStatus(event.id, ["received", "failed"], "processed", null);
    const loser = await repository.transitionPaymentEventStatus(event.id, ["received", "failed"], "failed", "must-not-win");
    expect(winner?.status).toBe("processed");
    expect(loser).toBeNull();
    expect(await repository.findPaymentEventById(event.id)).toMatchObject({ status: "processed", lastError: null });
  });

  it("returns null for an unknown historical event", async () => {
    expect(await repository.findPaymentEventById("evt-ghost")).toBeNull();
  });
});
