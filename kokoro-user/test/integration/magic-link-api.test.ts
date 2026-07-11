import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createUserServer } from "../../src/interfaces/http/server.js";
import { cleanUserDatabase, createTestPrismaClient } from "./helpers.js";

// 明显假密钥，仅用于集成测试。
const SECRET = "example-integration-hs256-secret";

// 复刻 session 验签核心，证明 magic-link 消费签出的 token 过 session 验签（含禁用前缀检查）。
const FORBIDDEN_PREFIXES = ["user:", "owner:", "team:", "site:", "workspace:"];
function sessionAccepts(
  token: string,
  secret: string,
): { ok: boolean; sub?: string | undefined; alg?: string | undefined } {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false };
  const [head, body, sig] = parts as [string, string, string];
  const expected = createHmac("sha256", secret).update(`${head}.${body}`).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false };
  const header = JSON.parse(Buffer.from(head, "base64url").toString("utf-8")) as { alg?: string };
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf-8")) as {
    sub?: string;
    exp?: number;
  };
  if (typeof payload.sub !== "string" || payload.sub.length === 0) return { ok: false };
  if (payload.exp !== undefined && payload.exp * 1000 <= Date.now()) return { ok: false };
  if (FORBIDDEN_PREFIXES.some((p) => payload.sub!.startsWith(p))) return { ok: false };
  return { ok: true, sub: payload.sub, alg: header.alg };
}

const prisma = createTestPrismaClient();
// dev response 档：一次性 token 回响应体，测试直接取用。
const app = createUserServer({
  prisma,
  sessionSigning: { secret: SECRET, ttlSeconds: 3600, issuer: "kokoro-user" },
  magicLinks: { deliveryMode: "response" },
});
// log 档：token 不回体。
const appLogDelivery = createUserServer({
  prisma,
  sessionSigning: { secret: SECRET, ttlSeconds: 3600, issuer: "kokoro-user" },
  magicLinks: { deliveryMode: "log" },
});
// 限频档：窗口内同邮箱最多 2 次。
const appRateLimited = createUserServer({
  prisma,
  sessionSigning: { secret: SECRET, ttlSeconds: 3600, issuer: "kokoro-user" },
  magicLinks: { deliveryMode: "response", rateLimitMax: 2, rateLimitWindowSeconds: 600 },
});
// 未配置签发密钥：消费 fail-closed。
const appNoSigning = createUserServer({ prisma, magicLinks: { deliveryMode: "response" } });

async function requestLink(email: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/auth/magic-links",
    payload: { site_id: "site-a", email },
  });
  expect(response.statusCode).toBe(200);
  return response.json().data.link_token as string;
}

async function cleanMagicLinks(): Promise<void> {
  await prisma.magicLink.deleteMany();
  await cleanUserDatabase(prisma);
}

describe("magic link HTTP API", () => {
  beforeEach(async () => {
    await cleanMagicLinks();
  });

  afterAll(async () => {
    await app.close();
    await appLogDelivery.close();
    await appRateLimited.close();
    await appNoSigning.close();
    await prisma.$disconnect();
  });

  it("issues a link and consuming it returns a session that passes session verification", async () => {
    const linkToken = await requestLink("flow@example.com");

    const consumed = await app.inject({
      method: "POST",
      url: "/auth/magic-links/consume",
      headers: { "x-kokoro-request-id": "req_magic" },
      payload: { token: linkToken },
    });

    expect(consumed.statusCode).toBe(200);
    const body = consumed.json();
    expect(body.requestId).toBe("req_magic");
    const { token, namespace, user, team } = body.data;

    // 复用 /auth/sessions 语义：resolve-or-create + namespace=personal teamId。
    expect(namespace).toBe(team.id);
    expect(team.type).toBe("personal");
    expect(user.externalUserId).toBe("email|flow@example.com");
    expect(user.email).toBe("flow@example.com");

    const verified = sessionAccepts(token, SECRET);
    expect(verified.ok).toBe(true);
    expect(verified.alg).toBe("HS256");
    expect(verified.sub).toBe(namespace);
  });

  it("stores only the token hash, never the raw token", async () => {
    const linkToken = await requestLink("hashed@example.com");

    const rows = await prisma.magicLink.findMany({ where: { email: "hashed@example.com" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).not.toBe(linkToken);
    expect(rows[0]!.tokenHash).toBe(createHash("sha256").update(linkToken).digest("hex"));
  });

  it("rejects a second consume of the same token with 401", async () => {
    const linkToken = await requestLink("replay@example.com");

    const first = await app.inject({
      method: "POST",
      url: "/auth/magic-links/consume",
      payload: { token: linkToken },
    });
    const second = await app.inject({
      method: "POST",
      url: "/auth/magic-links/consume",
      payload: { token: linkToken },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(401);
    expect(second.json()).toMatchObject({ error: { code: "auth.magic_link_invalid" } });
  });

  it("lets exactly one of two concurrent consumes win (conditional transfer)", async () => {
    const linkToken = await requestLink("race@example.com");

    const [a, b] = await Promise.all([
      app.inject({ method: "POST", url: "/auth/magic-links/consume", payload: { token: linkToken } }),
      app.inject({ method: "POST", url: "/auth/magic-links/consume", payload: { token: linkToken } }),
    ]);

    const statuses = [a.statusCode, b.statusCode].sort();
    expect(statuses).toEqual([200, 401]);
  });

  it("rejects an expired token with 401", async () => {
    const linkToken = await requestLink("expired@example.com");
    // 直接把库里的链推到过去，模拟 TTL 走完。
    await prisma.magicLink.updateMany({
      where: { email: "expired@example.com" },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const consumed = await app.inject({
      method: "POST",
      url: "/auth/magic-links/consume",
      payload: { token: linkToken },
    });

    expect(consumed.statusCode).toBe(401);
    expect(consumed.json()).toMatchObject({ error: { code: "auth.magic_link_invalid" } });
  });

  it("rejects a garbage token with 401 and an invalid payload with 400", async () => {
    const garbage = await app.inject({
      method: "POST",
      url: "/auth/magic-links/consume",
      payload: { token: "definitely-not-issued" },
    });
    expect(garbage.statusCode).toBe(401);
    expect(garbage.json()).toMatchObject({ error: { code: "auth.magic_link_invalid" } });

    const invalid = await app.inject({
      method: "POST",
      url: "/auth/magic-links",
      payload: { site_id: "site-a", email: "not-an-email" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { code: "request.invalid" } });
  });

  it("supersedes older unconsumed links for the same email; only the newest works", async () => {
    const oldToken = await requestLink("rotate@example.com");
    const newToken = await requestLink("rotate@example.com");

    const oldConsume = await app.inject({
      method: "POST",
      url: "/auth/magic-links/consume",
      payload: { token: oldToken },
    });
    const newConsume = await app.inject({
      method: "POST",
      url: "/auth/magic-links/consume",
      payload: { token: newToken },
    });

    expect(oldConsume.statusCode).toBe(401);
    expect(newConsume.statusCode).toBe(200);
  });

  it("rate limits repeated requests for the same email with 429", async () => {
    const payload = { site_id: "site-a", email: "limited@example.com" };
    const first = await appRateLimited.inject({ method: "POST", url: "/auth/magic-links", payload });
    const second = await appRateLimited.inject({ method: "POST", url: "/auth/magic-links", payload });
    const third = await appRateLimited.inject({
      method: "POST",
      url: "/auth/magic-links",
      headers: { "x-kokoro-request-id": "req_429" },
      payload,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(429);
    expect(third.json()).toMatchObject({
      requestId: "req_429",
      error: { code: "auth.magic_link_rate_limited" },
    });
  });

  it("log delivery mode never returns the token in the response body", async () => {
    const response = await appLogDelivery.inject({
      method: "POST",
      url: "/auth/magic-links",
      payload: { site_id: "site-a", email: "logged@example.com" },
    });

    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(data.email).toBe("logged@example.com");
    expect(data.link_token).toBeUndefined();
    // 链仍已落库（哈希），等待日志通道投递。
    expect(await prisma.magicLink.count({ where: { email: "logged@example.com" } })).toBe(1);
  });

  it("fail-closes consume with 503 when signing is not configured", async () => {
    const issued = await appNoSigning.inject({
      method: "POST",
      url: "/auth/magic-links",
      payload: { site_id: "site-a", email: "nosign@example.com" },
    });
    expect(issued.statusCode).toBe(200);

    const consumed = await appNoSigning.inject({
      method: "POST",
      url: "/auth/magic-links/consume",
      payload: { token: issued.json().data.link_token },
    });
    expect(consumed.statusCode).toBe(503);
    expect(consumed.json()).toMatchObject({ error: { code: "auth.not_configured" } });
  });

  it("refuses consumption for a deleted user with 409 and does not resurrect the link", async () => {
    // 先走一遍完整流建立用户，再删除该用户。
    const firstToken = await requestLink("deleted@example.com");
    const first = await app.inject({
      method: "POST",
      url: "/auth/magic-links/consume",
      payload: { token: firstToken },
    });
    const userId = first.json().data.user.id;
    await app.inject({
      method: "DELETE",
      url: `/users/${userId}`,
      payload: { deletedBy: "operator-1", reason: "closed" },
    });

    const secondToken = await requestLink("deleted@example.com");
    const denied = await app.inject({
      method: "POST",
      url: "/auth/magic-links/consume",
      payload: { token: secondToken },
    });

    expect(denied.statusCode).toBe(409);
    expect(denied.json()).toMatchObject({ error: { code: "user.deleted" } });
  });
});
