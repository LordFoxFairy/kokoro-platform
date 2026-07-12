import { afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createModelServer } from "../../src/interfaces/http/server.js";
import { createTestPrismaClient } from "./helpers.js";

// model route-access 负向矩阵（TRUST-ROUTES 验收）：model-bindings/resolve=可用性权威 runtime-internal。
const prisma = createTestPrismaClient();
const SECRETS = { session: "sec-session", admin: "sec-admin" } as const;
const app: FastifyInstance = createModelServer({ prisma, routeAccess: { secrets: SECRETS, isProduction: false } });
const SVC = "x-kokoro-service";
const SEC = "x-kokoro-internal-secret";

describe("model route-access 负向矩阵", () => {
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it("无 caller 头打 /model-bindings/resolve → 401", async () => {
    const res = await app.inject({ method: "POST", url: "/model-bindings/resolve", payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it("未知 caller → 401", async () => {
    const res = await app.inject({ method: "POST", url: "/model-bindings/resolve", headers: { [SVC]: "bogus", [SEC]: "x" }, payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it("对 caller 错 secret → 401", async () => {
    const res = await app.inject({ method: "POST", url: "/model-bindings/resolve", headers: { [SVC]: "session", [SEC]: "wrong" }, payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it("runtime 凭据（session）打 /admin/models → 403", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/models/provider-accounts", headers: { [SVC]: "session", [SEC]: SECRETS.session } });
    expect(res.statusCode).toBe(403);
  });

  it("session 凭据打 /model-bindings/resolve → 过 guard（非 401/403）", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/model-bindings/resolve",
      headers: { [SVC]: "session", [SEC]: SECRETS.session, "x-kokoro-site-id": "site-x" },
      payload: { featureKey: "chat" },
    });
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).not.toBe(403);
  });

  it("admin 凭据打 /admin/models → 200", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/models/provider-accounts", headers: { [SVC]: "admin", [SEC]: SECRETS.admin } });
    expect(res.statusCode).toBe(200);
  });

  it("/healthz 公开 → 无凭据放行", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
  });
});
