import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const generatedEffect = resolve(
  "src/generated/proto/kokoro/platform/site/v1/site_provisioning_pb.ts",
);
const generatedPublication = resolve(
  "src/generated/proto/kokoro/platform/site/v1/site_publication_pb.ts",
);
const provider = resolve("src/modules/site/interfaces/connect/site-provisioning-service.ts");

describe("Site release candidate authority boundary", () => {
  it("keeps candidate publication solely on the Root SitePublication boundary", async () => {
    const [provisioning, publication] = await Promise.all([
      readFile(generatedEffect, "utf8"),
      readFile(generatedPublication, "utf8"),
    ]);
    expect(provisioning).not.toContain("PublishSiteReleaseEffect");
    expect(provisioning).not.toContain("publishSiteRelease:");
    const effect = publication.slice(
      publication.indexOf("export type PublishSiteReleaseEffect"),
      publication.indexOf("export const PublishSiteReleaseEffectSchema"),
    );
    expect(effect).toContain("candidate?: CandidateAuthorityBinding");
    expect(effect).toContain("reason: string");
  });

  it("cannot revive direct publication from caller-supplied facts", async () => {
    const source = await readFile(provider, "utf8");

    expect(source).not.toMatch(/\.publishRelease\s*\(/u);
    expect(source).not.toContain("publishSiteRelease");
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
