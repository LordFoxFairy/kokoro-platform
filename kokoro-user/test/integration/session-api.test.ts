import { createHmac, timingSafeEqual } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createUserServer } from "../../src/interfaces/http/server.js";
import { cleanUserDatabase, createTestPrismaClient } from "./helpers.js";

// 明显假密钥，仅用于集成测试。
const SECRET = "example-integration-hs256-secret";

// 复刻 session 验签核心，证明真实签发的 token 过 session 验签（含禁用前缀检查）。
const FORBIDDEN_PREFIXES = ["user:", "owner:", "team:", "site:", "workspace:"];
function sessionAccepts(
  token: string,
  secret: string,
): { ok: boolean; sub?: string | undefined; exp?: number | undefined } {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false };
  const [head, body, sig] = parts as [string, string, string];
  const expected = createHmac("sha256", secret).update(`${head}.${body}`).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false };
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf-8")) as {
    sub?: string;
    exp?: number;
  };
  if (typeof payload.sub !== "string" || payload.sub.length === 0) return { ok: false };
  if (payload.exp !== undefined && payload.exp * 1000 <= Date.now()) return { ok: false };
  if (FORBIDDEN_PREFIXES.some((p) => payload.sub!.startsWith(p))) return { ok: false };
  return { ok: true, sub: payload.sub, exp: payload.exp };
}

const prisma = createTestPrismaClient();
const app = createUserServer({
  prisma,
  sessionSigning: { secret: SECRET, ttlSeconds: 3600, issuer: "kokoro-user" },
});
const appNoSigning = createUserServer({ prisma });

describe("session issuance HTTP API", () => {
  beforeEach(async () => {
    await cleanUserDatabase(prisma);
  });

  afterAll(async () => {
    await app.close();
    await appNoSigning.close();
    await prisma.$disconnect();
  });

  it("issues a session token that passes session verification", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/sessions",
      headers: { "x-request-id": "req_issue" },
      payload: { site_id: "site-a", external_user_id: "auth0|issue-me", email: "issue@example.com" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.requestId).toBe("req_issue");
    const { token, namespace, user, team } = body.data;

    expect(namespace).toBe(team.id);
    expect(team.type).toBe("personal");
    expect(user.externalUserId).toBe("auth0|issue-me");

    const verified = sessionAccepts(token, SECRET);
    expect(verified.ok).toBe(true);
    expect(verified.sub).toBe(namespace);
    expect(verified.exp).toEqual(expect.any(Number));
  });

  it("returns a stable namespace for repeated issuance of the same external user", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/auth/sessions",
      payload: { site_id: "site-a", external_user_id: "auth0|repeat" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/auth/sessions",
      payload: { site_id: "site-a", external_user_id: "auth0|repeat" },
    });

    expect(first.json().data.namespace).toBe(second.json().data.namespace);
  });

  it("rejects an invalid payload with a typed error", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/sessions",
      headers: { "x-request-id": "req_bad" },
      payload: { external_user_id: "auth0|no-site" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ requestId: "req_bad", error: { code: "request.invalid" } });
  });

  it("refuses issuance for a deleted user with 409", async () => {
    const ensured = await app.inject({
      method: "POST",
      url: "/auth/sessions",
      payload: { site_id: "site-a", external_user_id: "auth0|to-delete" },
    });
    const userId = ensured.json().data.user.id;

    await app.inject({
      method: "DELETE",
      url: `/users/${userId}`,
      payload: { deletedBy: "operator-1", reason: "closed" },
    });

    const denied = await app.inject({
      method: "POST",
      url: "/auth/sessions",
      payload: { site_id: "site-a", external_user_id: "auth0|to-delete" },
    });

    expect(denied.statusCode).toBe(409);
    expect(denied.json()).toMatchObject({ error: { code: "user.deleted" } });
  });

  it("fail-closes with 503 when signing is not configured", async () => {
    const response = await appNoSigning.inject({
      method: "POST",
      url: "/auth/sessions",
      payload: { site_id: "site-a", external_user_id: "auth0|no-secret" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: "auth.not_configured" } });
  });

  // requestId 头统一：新头 x-kokoro-request-id 优先，旧头 x-request-id 回退（两头都读，外部旧调用方不破）。
  // 走 503 路径断言，回显的 requestId 即 getRequestId 选中的头，无需落库。
  it("prefers x-kokoro-request-id over legacy x-request-id, still honoring legacy alone", async () => {
    const both = await appNoSigning.inject({
      method: "POST",
      url: "/auth/sessions",
      headers: { "x-kokoro-request-id": "req_new", "x-request-id": "req_old" },
      payload: { site_id: "site-a", external_user_id: "auth0|rid" },
    });
    expect(both.statusCode).toBe(503);
    expect(both.json().requestId).toBe("req_new");

    const legacyOnly = await appNoSigning.inject({
      method: "POST",
      url: "/auth/sessions",
      headers: { "x-request-id": "req_old" },
      payload: { site_id: "site-a", external_user_id: "auth0|rid" },
    });
    expect(legacyOnly.json().requestId).toBe("req_old");
  });
});
