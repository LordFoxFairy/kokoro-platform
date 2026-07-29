import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { normalizeIdentityEmail } from "../../src/modules/identity/domain/identity-email.js";
import { createIdentityPasswordHasher } from "../../src/modules/identity/infrastructure/crypto/identity-password-hasher.js";
import { createOpaqueCredentialCodec } from "../../src/modules/identity/infrastructure/crypto/opaque-credential.js";

describe("Platform Identity core security", () => {
  it("normalizes a Site-scoped email identity deterministically", () => {
    expect(normalizeIdentityEmail("  Alice@BÜCHER.Example  ")).toBe("alice@xn--bcher-kva.example");
    expect(() => normalizeIdentityEmail("a@@example.com")).toThrow("IDENTITY_EMAIL_INVALID");
    expect(() => normalizeIdentityEmail("a@invalid_domain")).toThrow("IDENTITY_EMAIL_INVALID");
  });

  it("hashes passwords with Argon2id and an explicit pepper version", async () => {
    const hasher = createIdentityPasswordHasher({
      currentPepperVersion: 7,
      peppers: [{ version: 7, secret: new Uint8Array(32).fill(7) }],
      memoryCostKiB: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
    const result = await hasher.hash("correct horse battery staple");
    expect(result.pepperVersion).toBe(7);
    expect(result.passwordHash).toMatch(/^\$argon2id\$/u);
    await expect(hasher.verify("correct horse battery staple", result)).resolves.toBe(true);
    await expect(hasher.verify("wrong horse battery staple", result)).resolves.toBe(false);
  });

  it("issues canonical opaque credentials and stores only keyed digests", () => {
    const codec = createOpaqueCredentialCodec(new Uint8Array(32).fill(9));
    const issued = codec.issue();
    expect(issued.credential).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(issued.digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(codec.digest(issued.credential)).toBe(issued.digest);
    expect(issued.digest).not.toContain(issued.credential);
  });

  it("declares composite Site ownership and bounded verification/session state", async () => {
    const migration = await readFile(
      "prisma/migrations/20260729_identity_core/migration.sql",
      "utf8",
    );
    const authorization = await readFile(
      "prisma/migrations/20260728_session_access_authorization/migration.sql",
      "utf8",
    );
    expect(migration).toContain("PRIMARY KEY(site_ref,account_ref)");
    expect(migration).toContain("identity_login_identifier_current_value_idx");
    expect(migration).toContain("identity_login_identifier_one_active_per_account_idx");
    expect(migration).not.toContain("UNIQUE(site_ref,email_normalized)");
    expect(migration).toContain("UNIQUE(site_ref,account_ref,subject_ref)");
    expect(migration).toContain("FOREIGN KEY(site_ref,account_ref,subject_ref)");
    expect(migration).toContain("attempt_count");
    expect(migration).toContain("max_attempts");
    expect(migration).toContain("identity_verification_legal_acceptance");
    expect(migration).toContain("identity_login_identifier");
    expect(migration).toContain("verification_pending");
    expect(migration).toContain("identity_personal_workspace");
    expect(migration).toContain("identity_workspace_membership");
    expect(migration).toContain("identity_execution_space");
    expect(migration).toContain("identity_namespace_allocation_intent");
    expect(migration).toContain("identity_personal_bootstrap");
    expect(migration).toContain("length(term_ref) BETWEEN 1 AND 128");
    expect(migration).toContain("identity_verification_delivery");
    expect(migration).toContain("verification_legal_acceptance_immutable");
    expect(migration).toContain("outbox_event(event_id)");
    expect(migration).not.toContain("delivery_state TEXT");
    expect(migration).toContain("identity_refresh_credential");
    expect(migration).toContain("identity_session_delivery_claim");
    expect(migration).toContain("security_epoch BIGINT NOT NULL DEFAULT 1");
    expect(migration).toContain("identity_totp_enrollment_transaction");
    expect(migration).toContain("identity_one_pending_totp_enrollment_idx");
    expect(migration).toContain("account_security_epoch");
    expect(migration).toContain("subject_generation");
    expect(migration).toContain("session_epoch");
    expect(migration).toContain("credential_epoch");
    expect(migration).toContain("identity_totp_enrollment_delivery_claim");
    expect(migration).toContain("identity_recovery_code_delivery_claim");
    expect(migration).toContain("identity_security_event");
    expect(migration).toContain("identity_security_event_immutable");
    expect(migration).not.toMatch(/manual_entry_secret|recovery_code_plaintext|otpauth_uri/iu);
    expect(authorization).toContain("identity_issuer_label TEXT NOT NULL");
    expect(authorization).toContain("identity_issuer_label=btrim(identity_issuer_label)");
    expect(authorization).toContain("length(identity_issuer_label) BETWEEN 1 AND 64");
    expect(authorization).toContain("authorization_site_release_identity_brand_immutable");
    expect(migration).toContain("device_label");
    expect(migration).toContain("last_seen_at");
    expect(migration).toContain("UNIQUE(site_ref,family_ref,generation)");
    expect(migration).toContain("REVOKE ALL ON");
  });
});
