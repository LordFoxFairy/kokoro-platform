import { createHmac, timingSafeEqual } from "node:crypto";
import { describe, expect, it } from "vitest";
import { JoseSessionSigner } from "../../src/infrastructure/auth/jose-session-signer.js";
import type { SessionTokenClaims } from "../../src/domain/session.js";

// 明显假密钥，仅用于本地单测；生产密钥来自 KOKORO_AUTH_JWT_SECRET，永不入库。
const SECRET = "example-shared-hs256-secret";

// 复刻 kokoro-session src/http/auth.ts 的验签核心（HMAC-SHA256 over head.body），
// 证明本签发器产出的 token 能过 session 验签，而无需跨仓 import。
function sessionVerify(token: string, secret: string): { header: unknown; payload: Record<string, unknown> } {
  const parts = token.split(".");
  expect(parts).toHaveLength(3);
  const [head, body, sig] = parts as [string, string, string];
  const expected = createHmac("sha256", secret).update(`${head}.${body}`).digest();
  const given = Buffer.from(sig, "base64url");
  expect(given.length).toBe(expected.length);
  expect(timingSafeEqual(given, expected)).toBe(true);
  return {
    header: JSON.parse(Buffer.from(head, "base64url").toString("utf-8")),
    payload: JSON.parse(Buffer.from(body, "base64url").toString("utf-8")),
  };
}

const claims: SessionTokenClaims = {
  sub: "clteam0001",
  iss: "kokoro-user",
  siteId: "site-a",
  issuedAtSeconds: 1_800_000_000,
  expiresAtSeconds: 1_800_003_600,
};

describe("JoseSessionSigner", () => {
  it("produces an HS256 token that passes session-compatible verification", async () => {
    const signer = new JoseSessionSigner(SECRET);
    const token = await signer.sign(claims);

    const { header, payload } = sessionVerify(token, SECRET);
    expect(header).toEqual({ alg: "HS256", typ: "JWT" });
    expect(payload.sub).toBe("clteam0001");
    expect(payload.exp).toBe(1_800_003_600);
    expect(payload.iat).toBe(1_800_000_000);
    expect(payload.iss).toBe("kokoro-user");
    expect(payload.site_id).toBe("site-a");
  });

  it("fails verification under a different secret", async () => {
    const token = await new JoseSessionSigner(SECRET).sign(claims);
    const parts = token.split(".");
    const [head, body, sig] = parts as [string, string, string];
    const wrong = createHmac("sha256", "another-secret").update(`${head}.${body}`).digest();
    expect(Buffer.from(sig, "base64url").equals(wrong)).toBe(false);
  });

  it("never embeds the secret in the token", async () => {
    const token = await new JoseSessionSigner(SECRET).sign(claims);
    expect(token.includes(SECRET)).toBe(false);
    expect(Buffer.from(token.split(".")[1] as string, "base64url").toString("utf-8")).not.toContain(SECRET);
  });
});
