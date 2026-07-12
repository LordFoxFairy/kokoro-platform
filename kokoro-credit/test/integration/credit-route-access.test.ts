import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createCreditServer } from "../../src/interfaces/http/server.js";
import { cleanCreditDatabase, createTestPrismaClient } from "./helpers.js";

// 入站访问控制负向矩阵（TRUST-ROUTES 验收）：credit default-internal，per-caller secret 校验。
const prisma = createTestPrismaClient();
const SECRETS = { session: "sec-session", admin: "sec-admin", "web-bff": "sec-webbff" } as const;
const app: FastifyInstance = createCreditServer({
  prisma,
  activeChecker: { async ensureAccountActive() {} },
  routeAccess: { secrets: SECRETS, isProduction: false },
});

const SVC = "x-kokoro-service";
const SEC = "x-kokoro-internal-secret";
const SITE = { "x-kokoro-site-id": "site-default" };

describe("credit route-access 负向矩阵", () => {
  beforeEach(async () => {
    await cleanCreditDatabase(prisma);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it("无 caller 头打 /credit → 401", async () => {
    const res = await app.inject({ method: "POST", url: "/credit/accounts/ensure", headers: SITE, payload: { ownerKind: "team", ownerId: "t1" } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("internal.unauthorized");
  });

  it("未知 caller → 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/credit/accounts/ensure",
      headers: { ...SITE, [SVC]: "bogus", [SEC]: "x" },
      payload: { ownerKind: "team", ownerId: "t1" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("对 caller 错 secret → 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/credit/accounts/ensure",
      headers: { ...SITE, [SVC]: "session", [SEC]: "wrong" },
      payload: { ownerKind: "team", ownerId: "t1" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("runtime 凭据（session）打 /admin/credits 路由 → 403", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/credits/accounts",
      headers: { [SVC]: "session", [SEC]: SECRETS.session },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("internal.forbidden");
  });

  it("web-bff 凭据打 runtime-internal /credit 路由 → 403（等级隔离）", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/credit/accounts/ensure",
      headers: { ...SITE, [SVC]: "web-bff", [SEC]: SECRETS["web-bff"] },
      payload: { ownerKind: "team", ownerId: "t1" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("session 凭据打 /credit 路由 → 放行（过 guard，账户创建）", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/credit/accounts/ensure",
      headers: { ...SITE, [SVC]: "session", [SEC]: SECRETS.session },
      payload: { ownerKind: "team", ownerId: "team_ra_ok" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.id).toBeTruthy();
  });

  it("admin 凭据打 /admin/credits 路由 → 放行", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/credits/accounts",
      headers: { [SVC]: "admin", [SEC]: SECRETS.admin },
    });
    expect(res.statusCode).toBe(200);
  });

  it("/healthz 公开 → 无凭据放行", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
  });
});
