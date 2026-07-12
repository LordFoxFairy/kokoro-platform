import { afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createPrismaClient } from "../../src/infrastructure/prisma/prisma-client.js";
import { createSiteServer } from "../../src/interfaces/http/server.js";

// site route-access 负向矩阵（TRUST-ROUTES 验收）：default-internal，per-caller secret。
if (!process.env.DATABASE_URL_SITE) {
  throw new Error("DATABASE_URL_SITE is required for integration tests");
}
const prisma = createPrismaClient(process.env.DATABASE_URL_SITE);
const SECRETS = { credit: "sec-credit", admin: "sec-admin", session: "sec-session" } as const;
const app: FastifyInstance = createSiteServer({ prisma, routeAccess: { secrets: SECRETS, isProduction: false } });
const SVC = "x-kokoro-service";
const SEC = "x-kokoro-internal-secret";

describe("site route-access 负向矩阵", () => {
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it("无 caller 头打 /sites → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/sites/s1/active" });
    expect(res.statusCode).toBe(401);
  });

  it("未知 caller → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/sites/s1/active", headers: { [SVC]: "bogus", [SEC]: "x" } });
    expect(res.statusCode).toBe(401);
  });

  it("对 caller 错 secret → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/sites/s1/active", headers: { [SVC]: "credit", [SEC]: "wrong" } });
    expect(res.statusCode).toBe(401);
  });

  it("runtime 凭据（session）打 /admin/sites → 403", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/sites", headers: { [SVC]: "session", [SEC]: SECRETS.session } });
    expect(res.statusCode).toBe(403);
  });

  it("credit 凭据打 runtime-internal /sites → 过 guard（非 401/403）", async () => {
    const res = await app.inject({ method: "GET", url: "/sites", headers: { [SVC]: "credit", [SEC]: SECRETS.credit } });
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).not.toBe(403);
  });

  it("admin 凭据打 /admin/sites → 200", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/sites", headers: { [SVC]: "admin", [SEC]: SECRETS.admin } });
    expect(res.statusCode).toBe(200);
  });

  it("/healthz 公开 → 无凭据放行", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
  });
});
