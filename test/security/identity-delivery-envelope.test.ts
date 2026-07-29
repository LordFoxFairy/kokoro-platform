import { describe, expect, it } from "vitest";
import { createIdentityAuditDigester } from "../../src/modules/identity/infrastructure/crypto/identity-audit-digester.js";
import { createVerificationEnvelopeSealer } from "../../src/modules/identity/infrastructure/crypto/verification-envelope-sealer.js";

describe("Identity secret-bearing delivery boundary", () => {
  it("creates keyed request digests without exposing secret input", () => {
    const digest = createIdentityAuditDigester(new Uint8Array(32).fill(3));
    const first = digest({ operation: "createIdentitySession", password: "secret-password" });
    const same = digest({ operation: "createIdentitySession", password: "secret-password" });
    const other = digest({ operation: "createIdentitySession", password: "other-password" });
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(first).toBe(same);
    expect(first).not.toBe(other);
    expect(first).not.toContain("secret-password");
  });

  it("puts only an authenticated encrypted envelope in the ordinary outbox payload", () => {
    const sealer = createVerificationEnvelopeSealer({
      keyRevision: "delivery-key-1",
      key: new Uint8Array(32).fill(4),
    });
    const sealed = sealer.seal({
      siteRef: "site-1",
      transactionRef: "transaction-1",
      email: "person@example.com",
      verificationSecret: "a".repeat(43),
      expiresAt: "2026-08-01T00:00:00.000Z",
    });
    const serialized = JSON.stringify(sealed);
    expect(serialized).not.toContain("person@example.com");
    expect(serialized).not.toContain("a".repeat(43));
    expect(sealed).toMatchObject({ algorithm: "A256GCM", keyRevision: "delivery-key-1" });
    expect(sealed.ciphertext).toMatch(/^[A-Za-z0-9_-]+$/u);
  });
});
