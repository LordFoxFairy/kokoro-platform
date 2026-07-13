import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { importJWK, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { JoseRs256SessionSigner } from "../../src/infrastructure/auth/jose-session-signer.js";
import { deriveKid, JwksProvider, loadRsaSigningKey } from "../../src/infrastructure/auth/rsa-keys.js";
import { resolveSessionSigning } from "../../src/infrastructure/auth/signing.js";

function rsaPem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

describe("loadRsaSigningKey", () => {
  it("derives a stable 16-hex kid from the public SPKI and exports a public-only JWK", () => {
    const pem = rsaPem();
    const key = loadRsaSigningKey(pem);

    expect(key.kid).toMatch(/^[0-9a-f]{16}$/);
    // kid 与直接从公钥推导一致（确定性）。
    expect(key.kid).toBe(deriveKid(createPublicKey(pem)));
    expect(key.publicJwk).toMatchObject({ kty: "RSA", use: "sig", alg: "RS256", kid: key.kid });
    // 公钥 JWK 不得含私钥分量。
    expect(key.publicJwk).not.toHaveProperty("d");
    expect(key.publicJwk).not.toHaveProperty("p");
  });

  it("rejects a non-RSA key (fail-loud at startup)", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(() => loadRsaSigningKey(pem)).toThrow(/RSA/);
  });

  it("rejects malformed PEM", () => {
    expect(() => loadRsaSigningKey("not-a-key")).toThrow();
  });
});

describe("JwksProvider", () => {
  it("serves the current key alone when no previous key", () => {
    const current = loadRsaSigningKey(rsaPem());
    expect(new JwksProvider(current).jwks().keys).toEqual([current.publicJwk]);
  });

  it("serves current + previous for rotation, deduping identical kid", () => {
    const current = loadRsaSigningKey(rsaPem());
    const previous = loadRsaSigningKey(rsaPem());
    const rotated = new JwksProvider(current, previous).jwks().keys;
    expect(rotated.map((k) => k.kid)).toEqual([current.kid, previous.kid]);

    // 同一把键作为 current 与 previous → 只出现一次。
    expect(new JwksProvider(current, current).jwks().keys).toHaveLength(1);
  });
});

describe("JoseRs256SessionSigner + JWKS round-trip", () => {
  it("signs an RS256 token with kid header that verifies against the published JWK", async () => {
    const key = loadRsaSigningKey(rsaPem());
    const signer = new JoseRs256SessionSigner(key);
    const token = await signer.sign({
      sub: "team-abc",
      iss: "kokoro-user",
      siteId: "site-a",
      issuedAtSeconds: 1_000_000,
      expiresAtSeconds: 1_000_000 + 3600,
    });

    const [encodedHeader] = token.split(".");
    const header = JSON.parse(Buffer.from(encodedHeader!, "base64url").toString("utf-8"));
    expect(header).toMatchObject({ alg: "RS256", kid: key.kid });

    // 用 JWKS 暴露的公钥验签成功，声明齐备（currentDate 固定在 token 有效窗口内，不受真实时钟影响）。
    const publicKey = await importJWK(key.publicJwk, "RS256");
    const { payload } = await jwtVerify(token, publicKey, {
      algorithms: ["RS256"],
      currentDate: new Date(1_000_100 * 1000),
    });
    expect(payload).toMatchObject({ sub: "team-abc", iss: "kokoro-user", site_id: "site-a" });
  });
});

describe("resolveSessionSigning", () => {
  it("resolves RS256 signer + JWKS when a private key is configured", () => {
    const resolved = resolveSessionSigning({ privateKeyPem: rsaPem(), isProduction: true });
    expect(resolved).not.toBeNull();
    expect(resolved!.jwks).toBeInstanceOf(JwksProvider);
    expect(resolved!.jwks!.jwks().keys).toHaveLength(1);
  });

  it("includes the previous public key in JWKS for rotation", () => {
    const resolved = resolveSessionSigning({
      privateKeyPem: rsaPem(),
      previousPrivateKeyPem: rsaPem(),
      isProduction: true,
    });
    expect(resolved!.jwks!.jwks().keys).toHaveLength(2);
  });

  it("falls back to HS256 (no JWKS) only in non-production", () => {
    const resolved = resolveSessionSigning({ hs256Secret: "dev-secret", isProduction: false });
    expect(resolved).not.toBeNull();
    expect(resolved!.jwks).toBeNull();
  });

  it("fails fast in production when only an HS256 secret is configured", () => {
    expect(() => resolveSessionSigning({ hs256Secret: "shared", isProduction: true })).toThrow(
      /KOKORO_USER_JWT_PRIVATE_KEY/,
    );
  });

  it("fails fast in production when nothing is configured", () => {
    expect(() => resolveSessionSigning({ isProduction: true })).toThrow(/production/);
  });

  it("returns null (fail-closed 503 upstream) when nothing configured in non-production", () => {
    expect(resolveSessionSigning({ isProduction: false })).toBeNull();
  });
});
