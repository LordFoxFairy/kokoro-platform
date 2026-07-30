import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalCertificationPayload,
  Ed25519SiteReleaseCertificationAuthority,
} from
  "../../src/modules/site/infrastructure/crypto/site-release-certification-authority.js";

describe("Ed25519SiteReleaseCertificationAuthority", () => {
  it("binds the release artifact, manifest, launch profile, key and validity window", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const facts = {
      siteRef: "site_01",
      releaseRef: "release_01",
      webArtifactDigest: "a".repeat(64),
      releaseManifestDigest: "b".repeat(64),
      launchProfileRef: "launch_profile_01",
      siteConfigRevisionRef: "site_config_01",
      legalRevisionRef: "legal_01",
      featurePolicyRevision: "feature_policy_01",
      modelOptionCatalogRef: "model_catalog_01",
      agentCatalogRef: "agent_catalog_01",
      identityIssuerLabel: "Image Studio",
      identityAuthStrengthPolicyRevision: "identity_policy_01",
      enabledSurfaceIds: ["account", "chat"],
      localePolicy: { defaultLocale: "en-US", allowedLocales: ["en-US", "zh-CN"] },
      proof: {
        signingKeyRef: "release-key-01",
        issuedAt: "2026-07-30T10:00:00.000Z",
        expiresAt: "2026-07-30T11:00:00.000Z",
      },
    } as const;
    const payload = canonicalCertificationPayload(facts);
    const certificationDigest = createHash("sha256").update(payload).digest("hex");
    const signature = sign(null, Buffer.concat([
      Buffer.from("kokoro.site-release-certification.v1\0"),
      Buffer.from(payload),
    ]), privateKey);
    const authority = new Ed25519SiteReleaseCertificationAuthority([{
      signingKeyRef: facts.proof.signingKeyRef,
      publicKey,
    }]);

    await expect(authority.verify({
      ...facts,
      certificationDigest,
      proof: { ...facts.proof, signature },
    })).resolves.toEqual({ status: "passed", expiresAt: facts.proof.expiresAt });

    await expect(authority.verify({
      ...facts,
      releaseRef: "release_02",
      certificationDigest,
      proof: { ...facts.proof, signature },
    })).rejects.toThrow("SITE_RELEASE_CERTIFICATION_DIGEST_INVALID");

    await expect(authority.verify({
      ...facts,
      modelOptionCatalogRef: "model_catalog_02",
      certificationDigest,
      proof: { ...facts.proof, signature },
    })).rejects.toThrow("SITE_RELEASE_CERTIFICATION_DIGEST_INVALID");
  });
});
