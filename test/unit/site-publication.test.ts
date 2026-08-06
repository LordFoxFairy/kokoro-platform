import { describe, expect, it } from "vitest";
import {
  createPreviewReadySite,
  createSiteProjectBinding,
  publishCertifiedSiteRelease,
} from "../../src/modules/site/domain/site-publication.js";

describe("Site publication", () => {
  it("creates one stable Site and one independently deployed project binding", () => {
    const site = createPreviewReadySite({ siteRef: "site_01", siteKey: "image-studio" });
    const binding = createSiteProjectBinding({
      bindingRef: "binding_01", siteRef: site.siteRef,
      repositoryRef: "github:thefoxfairy/image-studio", providerProjectRef: "vercel:project-image-studio",
      providerNamespace: "vercel", region: "us-east-1",
      environment: "production", workloadIdentityId: "spiffe://kokoro/site/image-studio/production",
    });
    expect(site).toMatchObject({ state: "preview_ready", activeReleaseRef: null });
    expect(binding).toMatchObject({ state: "active", bindingEpoch: 1n, siteRef: "site_01",
      providerNamespace: "vercel", region: "us-east-1" });
    expect(() => createSiteProjectBinding({
      bindingRef: "binding_02", siteRef: site.siteRef,
      repositoryRef: "github:thefoxfairy/image-studio", providerProjectRef: "project-image-studio",
      providerNamespace: "Vercel/unsafe", region: "us-east-1",
      environment: "production", workloadIdentityId: "spiffe://kokoro/site/image-studio/production",
    })).toThrow("SITE_PROVIDER_NAMESPACE_INVALID");
  });

  it("freezes the complete certified release snapshot without provider secrets", () => {
    const release = publishCertifiedSiteRelease({
      releaseRef: "release_01", siteRef: "site_01", webArtifactDigest: "a".repeat(64),
      releaseManifestDigest: "b".repeat(64), certificationDigest: "c".repeat(64),
      launchProfileRef: "core-redeem-chat@1", siteConfigRevisionRef: "config_01",
      legalRevisionRef: "legal_01", featurePolicyRevision: "policy_01",
      modelOptionCatalogRef: "model_catalog_01", agentCatalogRef: "agent_catalog_01",
      identityIssuerLabel: "Image Studio", identityAuthStrengthPolicyRevision: "auth_policy_01",
      enabledSurfaceIds: ["account", "redemption", "chat"],
      localePolicy: { defaultLocale: "en-US", allowedLocales: ["en-US"] },
    });
    expect(release.state).toBe("ready");
    expect(release.enabledSurfaceIds).toEqual(["account", "chat", "redemption"]);
    expect(JSON.stringify(release)).not.toMatch(/secret|credential|providerAccount/iu);
  });

  it("rejects duplicate surfaces and an issuer unsuitable for an authenticator label", () => {
    const base = {
      releaseRef: "release_01", siteRef: "site_01", webArtifactDigest: "a".repeat(64),
      releaseManifestDigest: "b".repeat(64), certificationDigest: "c".repeat(64),
      launchProfileRef: "core-redeem-chat@1", siteConfigRevisionRef: "config_01",
      legalRevisionRef: "legal_01", featurePolicyRevision: "policy_01",
      modelOptionCatalogRef: "model_catalog_01", agentCatalogRef: "agent_catalog_01",
      identityIssuerLabel: "Image Studio", identityAuthStrengthPolicyRevision: "auth_policy_01",
      enabledSurfaceIds: ["account"],
      localePolicy: { defaultLocale: "en-US", allowedLocales: ["en-US"] },
    } as const;
    expect(() => publishCertifiedSiteRelease({ ...base, enabledSurfaceIds: ["chat", "chat"] }))
      .toThrow("SITE_RELEASE_SURFACES_INVALID");
    expect(() => publishCertifiedSiteRelease({ ...base, identityIssuerLabel: "bad:issuer" }))
      .toThrow("SITE_IDENTITY_ISSUER_LABEL_INVALID");
    expect(() => publishCertifiedSiteRelease({ ...base,
      identityAuthStrengthPolicyRevision: "bad:policy" }))
      .toThrow("SITE_AUTH_POLICY_REVISION_INVALID");
  });
});
