import type { PrismaClient } from "../../generated/prisma/index.js";
import { describe, expect, it, vi } from "vitest";
import { createPrismaPaymentReadCapabilities } from "../../src/infrastructure/prisma/prisma-payment-read-repository.js";
import { createPaymentServer } from "../../src/interfaces/http/server.js";

const DISABLED_CODE = "ACQUISITION_CHANNEL_DISABLED";

function noDatabasePrisma(calls: string[]): PrismaClient {
  const client = new Proxy(
    { $disconnect: vi.fn() },
    {
      get(target, model: string) {
        if (model in target) return target[model as keyof typeof target];
        return new Proxy({}, {
          get(_modelTarget, method: string) {
            return vi.fn(async () => {
              calls.push(`${model}.${method}`);
              throw new Error(`unexpected database access: ${model}.${method}`);
            });
          },
        });
      },
    },
  );
  return client as unknown as PrismaClient;
}

function globalReadPrisma(calls: string[]): PrismaClient {
  return new Proxy(
    {},
    {
      get(_target, model: string) {
        return {
          findMany: vi.fn(async () => {
            calls.push(`${model}.findMany`);
            return [];
          }),
        };
      },
    },
  ) as unknown as PrismaClient;
}

type RequestCase = { method: "POST" | "DELETE"; url: string; payload?: Record<string, unknown> };

const disabledRuntimeRequests: readonly RequestCase[] = [
  { method: "POST", url: "/orders/checkout", payload: { teamId: "team-1", planId: "plan-1" } },
  { method: "POST", url: "/orders", payload: { teamId: "team-1", planId: "plan-1", amountMinor: "1", currency: "USD", idempotencyKey: "k" } },
  { method: "POST", url: "/orders/sweep" },
  { method: "POST", url: "/orders/order-1/confirm" },
  { method: "POST", url: "/orders/order-1/refund" },
  { method: "POST", url: "/payment-events/record", payload: { provider: "mock", eventId: "evt-1", eventType: "paid", payload: {} } },
  { method: "POST", url: "/payments/webhooks/mock", payload: { eventId: "evt-1" } },
];

const absentAdminMutationRequests: readonly RequestCase[] = [
  { method: "POST", url: "/admin/payments/grant-plan", payload: { teamId: "team-1", planId: "plan-1" } },
  { method: "POST", url: "/admin/payments/providers/upsert", payload: { key: "mock" } },
  { method: "DELETE", url: "/admin/payments/providers/mock" },
  { method: "POST", url: "/admin/payments/events/event-1/replay" },
  { method: "POST", url: "/plans/upsert", payload: {} },
  { method: "DELETE", url: "/plans/plan-1", payload: {} },
  { method: "POST", url: "/plans/plan-1/restore" },
];

describe("redeem-only payment acquisition shutdown", () => {
  it.each(disabledRuntimeRequests)("returns the stable disabled envelope for $method $url without touching persistence", async (request) => {
    const databaseCalls: string[] = [];
    const app = createPaymentServer({
      readCapabilities: createPrismaPaymentReadCapabilities(noDatabasePrisma(databaseCalls)),
    });
    try {
      const response = await app.inject({
        method: request.method,
        url: request.url,
        headers: { "x-kokoro-site-id": "site-1" },
        ...(request.payload === undefined ? {} : { payload: request.payload }),
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: { code: DISABLED_CODE } });
      expect(databaseCalls).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("rejects provider form payloads with the same envelope without touching persistence", async () => {
    const databaseCalls: string[] = [];
    const app = createPaymentServer({
      readCapabilities: createPrismaPaymentReadCapabilities(noDatabasePrisma(databaseCalls)),
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/payments/webhooks/alipay",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: "trade_status=TRADE_SUCCESS&out_trade_no=order-1",
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: { code: DISABLED_CODE } });
      expect(databaseCalls).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("preserves Web BFF checkout and Session order boundaries while denying acquisition", async () => {
    const databaseCalls: string[] = [];
    const app = createPaymentServer({
      readCapabilities: createPrismaPaymentReadCapabilities(noDatabasePrisma(databaseCalls)),
      routeAccess: {
        secrets: { "web-bff": "web-secret", session: "session-secret" },
        isProduction: false,
      },
    });
    try {
      const checkout = await app.inject({
        method: "POST",
        url: "/orders/checkout",
        headers: { "x-kokoro-service": "web-bff", "x-kokoro-internal-secret": "web-secret" },
      });
      const confirm = await app.inject({
        method: "POST",
        url: "/orders/order-1/confirm",
        headers: { "x-kokoro-service": "session", "x-kokoro-internal-secret": "session-secret" },
      });
      const crossBoundary = await app.inject({
        method: "POST",
        url: "/orders/order-1/confirm",
        headers: { "x-kokoro-service": "web-bff", "x-kokoro-internal-secret": "web-secret" },
      });

      expect(checkout.statusCode).toBe(503);
      expect(checkout.json()).toMatchObject({ error: { code: DISABLED_CODE } });
      expect(confirm.statusCode).toBe(503);
      expect(confirm.json()).toMatchObject({ error: { code: DISABLED_CODE } });
      expect(crossBoundary.statusCode).toBe(403);
      expect(databaseCalls).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("allows a Site-less global history read only through the explicit Admin plane", async () => {
    const databaseCalls: string[] = [];
    const app = createPaymentServer({
      readCapabilities: createPrismaPaymentReadCapabilities(globalReadPrisma(databaseCalls)),
      routeAccess: {
        secrets: { admin: "admin-secret", "web-bff": "web-secret" },
        isProduction: false,
      },
    });
    try {
      const denied = await app.inject({
        method: "GET",
        url: "/admin/payments/providers",
        headers: { "x-kokoro-service": "web-bff", "x-kokoro-internal-secret": "web-secret" },
      });
      expect(denied.statusCode).toBe(403);
      expect(databaseCalls).toEqual([]);

      const allowed = await app.inject({
        method: "GET",
        url: "/admin/payments/providers",
        headers: { "x-kokoro-service": "admin", "x-kokoro-internal-secret": "admin-secret" },
      });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json().data).toEqual([]);
      expect(databaseCalls).toEqual(["paymentProvider.findMany"]);
    } finally {
      await app.close();
    }
  });

  it.each(absentAdminMutationRequests)("does not register $method $url", async (request) => {
    const databaseCalls: string[] = [];
    const app = createPaymentServer({
      readCapabilities: createPrismaPaymentReadCapabilities(noDatabasePrisma(databaseCalls)),
    });
    try {
      const response = await app.inject({
        method: request.method,
        url: request.url,
        headers: { "x-kokoro-site-id": "site-1" },
        ...(request.payload === undefined ? {} : { payload: request.payload }),
      });
      expect(response.statusCode).toBe(404);
      expect(databaseCalls).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
