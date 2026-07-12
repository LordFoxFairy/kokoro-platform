import { afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createPaymentServer } from "../../src/interfaces/http/server.js";
import { createTestPrismaClient, recordingGrant, recordingReverse } from "./helpers.js";

// payment route-access 负向矩阵（TRUST-ROUTES 验收）：/payments/webhooks 公开(另验 provider 签名)，其余 default-internal。
const prisma = createTestPrismaClient();
const SECRETS = { admin: "sec-admin", payment: "sec-payment", session: "sec-session" } as const;
const app: FastifyInstance = createPaymentServer({
  prisma,
  grantPurchaseCredits: recordingGrant().grantPurchaseCredits,
  reverseCredits: recordingReverse().reverseCredits,
  routeAccess: { secrets: SECRETS, isProduction: false },
});
const SVC = "x-kokoro-service";
const SEC = "x-kokoro-internal-secret";

describe("payment route-access 负向矩阵", () => {
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it("公开 webhook：无 caller 头 /payments/webhooks/:provider → 过 guard（非 401/403）", async () => {
    const res = await app.inject({ method: "POST", url: "/payments/webhooks/stripe", payload: {} });
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).not.toBe(403);
  });

  it("无 caller 头打 /orders → 401", async () => {
    const res = await app.inject({ method: "POST", url: "/orders", payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it("未知 caller → 401", async () => {
    const res = await app.inject({ method: "POST", url: "/orders", headers: { [SVC]: "bogus", [SEC]: "x" }, payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it("对 caller 错 secret → 401", async () => {
    const res = await app.inject({ method: "POST", url: "/orders", headers: { [SVC]: "session", [SEC]: "wrong" }, payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it("runtime 凭据（session）打 /admin/payments → 403", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/payments/manifest", headers: { [SVC]: "session", [SEC]: SECRETS.session } });
    expect(res.statusCode).toBe(403);
  });

  it("session 凭据打 runtime-internal /orders → 过 guard（非 401/403）", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { [SVC]: "session", [SEC]: SECRETS.session, "x-kokoro-site-id": "site-x" },
      payload: { planId: "nonexistent" },
    });
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).not.toBe(403);
  });

  it("admin 凭据打 /admin/payments → 200", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/payments/manifest", headers: { [SVC]: "admin", [SEC]: SECRETS.admin } });
    expect(res.statusCode).toBe(200);
  });

  it("/healthz 公开 → 无凭据放行", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
  });
});
