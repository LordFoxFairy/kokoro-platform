import type { FastifyInstance } from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { createPaymentServer } from "../../src/interfaces/http/server.js";
import { createTestPrismaClient } from "./helpers.js";

const prisma = createTestPrismaClient();
const SECRETS = { admin: "sec-admin", "web-bff": "sec-web", session: "sec-session" } as const;
const app: FastifyInstance = createPaymentServer({
  prisma,
  routeAccess: { secrets: SECRETS, isProduction: false },
});
const SVC = "x-kokoro-service";
const SEC = "x-kokoro-internal-secret";

describe("payment redeem-only route access", () => {
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it("keeps provider webhook denial public", async () => {
    const response = await app.inject({ method: "POST", url: "/payments/webhooks/stripe", payload: {} });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("ACQUISITION_CHANNEL_DISABLED");
  });

  it("requires a caller for disabled order routes", async () => {
    expect((await app.inject({ method: "POST", url: "/orders", payload: {} })).statusCode).toBe(401);
  });

  it("rejects unknown callers and wrong secrets", async () => {
    expect((await app.inject({ method: "POST", url: "/orders", headers: { [SVC]: "bogus", [SEC]: "x" }, payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/orders", headers: { [SVC]: "web-bff", [SEC]: "wrong" }, payload: {} })).statusCode).toBe(401);
  });

  it("lets Web BFF reach the stable checkout denial envelope", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/orders/checkout",
      headers: { [SVC]: "web-bff", [SEC]: SECRETS["web-bff"], "x-kokoro-site-id": "site-x" },
      payload: {},
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("ACQUISITION_CHANNEL_DISABLED");
  });

  it("lets Session reach the stable internal order denial envelope", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/orders/order-1/confirm",
      headers: { [SVC]: "session", [SEC]: SECRETS.session, "x-kokoro-site-id": "site-x" },
      payload: {},
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("ACQUISITION_CHANNEL_DISABLED");
  });

  it("isolates Admin reads from Web BFF", async () => {
    expect((await app.inject({ method: "GET", url: "/admin/payments/manifest", headers: { [SVC]: "web-bff", [SEC]: SECRETS["web-bff"] } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/admin/payments/manifest", headers: { [SVC]: "admin", [SEC]: SECRETS.admin } })).statusCode).toBe(200);
  });

  it("keeps health public", async () => {
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
  });
});
