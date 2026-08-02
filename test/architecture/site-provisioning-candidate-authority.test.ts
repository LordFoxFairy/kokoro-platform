import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const generatedEffect = resolve(
  "src/interfaces/connect/generated-site-provisioning/kokoro/platform/site/v1/site_provisioning_pb.ts",
);
const provider = resolve("src/modules/site/interfaces/connect/site-provisioning-service.ts");

describe("Site release candidate authority boundary", () => {
  it("accepts only the Root-owned candidate command facts", async () => {
    const generated = await readFile(generatedEffect, "utf8");
    const effect = generated.slice(
      generated.indexOf("export type PublishSiteReleaseEffect"),
      generated.indexOf("export const PublishSiteReleaseEffectSchema"),
    );

    expect(effect).toContain("siteReleaseCandidateRef: string");
    expect(effect).toContain("expectedCandidateVersion: bigint");
    expect(effect).toContain("reason: string");
    for (const staleFact of [
      "releaseRef", "webArtifactDigest", "releaseManifestDigest", "certificationDigest",
      "launchProfileRef", "siteConfigRevisionRef", "legalRevisionRef", "featurePolicyRevision",
      "modelOptionCatalogRef", "agentCatalogRef", "identityIssuerLabel",
      "identityAuthStrengthPolicyRevision", "enabledSurfaceIds", "localePolicy", "certification",
    ]) expect(effect, staleFact).not.toContain(staleFact);
  });

  it("cannot revive direct publication from caller-supplied facts", async () => {
    const source = await readFile(provider, "utf8");

    expect(source).not.toMatch(/\.publishRelease\s*\(/u);
    for (const staleFact of [
      "effect.releaseRef", "effect.webArtifactDigest", "effect.releaseManifestDigest",
      "effect.certificationDigest", "effect.launchProfileRef", "effect.siteConfigRevisionRef",
      "effect.legalRevisionRef", "effect.featurePolicyRevision", "effect.modelOptionCatalogRef",
      "effect.agentCatalogRef", "effect.identityIssuerLabel",
      "effect.identityAuthStrengthPolicyRevision", "effect.enabledSurfaceIds", "effect.localePolicy",
      "effect.certification",
    ]) expect(source, staleFact).not.toContain(staleFact);
  });
});
