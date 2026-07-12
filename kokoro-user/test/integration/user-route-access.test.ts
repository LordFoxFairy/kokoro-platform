import { afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createUserServer } from "../../src/interfaces/http/server.js";
import { createTestPrismaClient } from "./helpers.js";

// user route-access 负向矩阵（TRUST-ROUTES 验收）：magic-links=web-bff、/auth/sessions 收编 runtime-internal。
const prisma = createTestPrismaClient();
const SECRETS = {
  credit: "sec-credit",
  "web-bff": "sec-webbff",
  session: "sec-session",
  admin: "sec-admin",
} as const;
const app: FastifyInstance = createUserServer({ prisma, routeAccess: { secrets: SECRETS, isProduction: false } });
const SVC = "x-kokoro-service";
const SEC = "x-kokoro-internal-secret";

describe("user route-access 负向矩阵", () => {
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it("无 caller 头打 /owners → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/owners/team/t1/active" });
    expect(res.statusCode).toBe(401);
  });

  it("未知 caller → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/owners/team/t1/active", headers: { [SVC]: "bogus", [SEC]: "x" } });
    expect(res.statusCode).toBe(401);
  });

  it("对 caller 错 secret → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/owners/team/t1/active", headers: { [SVC]: "credit", [SEC]: "wrong" } });
    expect(res.statusCode).toBe(401);
  });

  it("runtime 凭据（session）打 /admin/users → 403", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/users", headers: { [SVC]: "session", [SEC]: SECRETS.session } });
    expect(res.statusCode).toBe(403);
  });

  it("web-bff 凭据打 /auth/magic-links → 过 guard（非 401/403）", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/magic-links",
      headers: { [SVC]: "web-bff", [SEC]: SECRETS["web-bff"] },
      payload: { email: "user@example.com", site_id: "site-x" },
    });
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).not.toBe(403);
  });

  it("runtime 凭据（session）打 web-bff /auth/magic-links → 403（等级隔离）", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/magic-links",
      headers: { [SVC]: "session", [SEC]: SECRETS.session },
      payload: { email: "user@example.com", site_id: "site-x" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("web-bff 凭据打 runtime-internal /auth/sessions → 403（收编后不再对 web-bff 开放）", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/sessions",
      headers: { [SVC]: "web-bff", [SEC]: SECRETS["web-bff"] },
      payload: { site_id: "site-x", external_user_id: "u1" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("session 凭据打 /auth/sessions → 过 guard（非 401/403）", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/sessions",
      headers: { [SVC]: "session", [SEC]: SECRETS.session },
      payload: { site_id: "site-x", external_user_id: "u1" },
    });
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).not.toBe(403);
  });

  it("admin 凭据打 /admin/users → 200", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/users", headers: { [SVC]: "admin", [SEC]: SECRETS.admin } });
    expect(res.statusCode).toBe(200);
  });

  it("/healthz 公开 → 无凭据放行", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
  });
});
