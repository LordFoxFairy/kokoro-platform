import { describe, expect, it } from "vitest";
import { generate, generateSecret } from "otplib";
import { createIdentityTotpVerifier } from "../../src/modules/identity/infrastructure/crypto/identity-totp-verifier.js";
import { createIdentityTotpSecretProtector } from "../../src/modules/identity/infrastructure/crypto/identity-totp-secret-protector.js";
import {
  createIdentityRecoveryCodeIssuer,
  createIdentityTotpEnrollmentIssuer,
} from "../../src/modules/identity/infrastructure/crypto/identity-security-credential-issuer.js";

describe("Identity TOTP cryptography adapters", () => {
  it("uses otplib verification and rejects the same accepted timestep", async () => {
    const epochSeconds = 1_785_283_200;
    const secret = generateSecret();
    const code = await generate({ secret, epoch: epochSeconds });
    const verifier = createIdentityTotpVerifier();

    const first = await verifier.verify({ secret, code, epochSeconds, afterTimeStep: null });
    expect(first.valid).toBe(true);
    if (!first.valid) throw new Error("expected a valid TOTP");
    const replay = await verifier.verify({
      secret,
      code,
      epochSeconds,
      afterTimeStep: first.timeStep,
    });
    expect(replay).toEqual({ valid: false });
  });

  it("binds an encrypted TOTP secret to the exact Site account and authenticator", () => {
    const protector = createIdentityTotpSecretProtector({
      currentKeyRevision: "totp-key-1",
      keys: [{ keyRevision: "totp-key-1", key: new Uint8Array(32).fill(7) }],
    });
    const binding = {
      siteRef: "site-1",
      accountRef: "account-1",
      subjectRef: "subject-1",
      authenticatorRef: "totp-1",
    };
    const secret = generateSecret();
    const envelope = protector.seal(secret, binding);

    expect(protector.unseal(envelope, binding)).toBe(secret);
    expect(() => protector.unseal(envelope, { ...binding, accountRef: "account-2" })).toThrow();
  });

  it("puts the caller-supplied SiteRelease brand into the standards-based otpauth URI", async () => {
    const issued = await createIdentityTotpEnrollmentIssuer().issue({
      issuer: "Lumen Studio",
      accountLabel: "person@example.com",
    });
    const uri = new URL(issued.otpauthUri);

    expect(uri.protocol).toBe("otpauth:");
    expect(uri.searchParams.get("issuer")).toBe("Lumen Studio");
    expect(decodeURIComponent(uri.pathname)).toContain("Lumen Studio:person@example.com");
    expect(uri.searchParams.get("secret")).toBe(issued.secret);
  });

  it("issues ten unique 144-bit recovery capabilities", () => {
    const codes = createIdentityRecoveryCodeIssuer().issue();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    expect(codes.every((value) => /^[A-Za-z0-9_-]{24}$/u.test(value))).toBe(true);
  });
});
