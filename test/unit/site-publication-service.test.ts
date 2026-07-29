import { describe, expect, it } from "vitest";
import { SitePublicationService } from "../../src/modules/site/application/services/site-publication-service.js";
import type { SiteAuthorityJournal, SiteAuthorityRepository } from "../../src/modules/site/application/contracts/site-authority-ports.js";
import type { SitePublicationRepository } from "../../src/modules/site/application/contracts/site-publication-ports.js";
import { issuePlatformTransaction, revokePlatformTransaction } from "../../src/shared/unit-of-work/platform-transaction.js";
import { PlatformUnitOfWork } from "../../src/shared/unit-of-work/unit-of-work.js";
import { verifyRequestSecurityContext } from "../../src/shared/security-context/request-security-context.js";

describe("SitePublicationService", () => {
  it("persists a certified immutable release and command evidence in one transaction", async () => {
    const calls: string[] = [];
    const repository = {
      ...baseRepository(),
      loadSiteForUpdate: async () => ({ siteRef: "site_01", state: "preview_ready", activeReleaseRef: null,
        securityEpoch: 1n, policyEpoch: 1n, revocationEpoch: 1n }),
      loadReleaseForUpdate: async () => null,
      insertRelease: async (_transaction, release) => { calls.push(`release:${release.releaseRef}`); },
    } satisfies SiteAuthorityRepository & SitePublicationRepository;
    const journal: SiteAuthorityJournal = {
      begin: async () => { calls.push("begin"); return "fresh"; },
      succeed: async () => { calls.push("succeed"); },
    };
    const service = new SitePublicationService(unitOfWork(), repository, journal, {
      verify: async (facts) => {
        calls.push(`certify:${facts.releaseRef}`);
        return { status: "passed", expiresAt: "2026-07-29T12:00:00.000Z" };
      },
    }, { now: () => "2026-07-28T12:00:00.000Z" });

    const receipt = await service.publishRelease({
      commandId: "01983f57-8cf1-7000-8000-000000000011", idempotencyKey: "site-release-command-01",
      releaseRef: "release_01", siteRef: "site_01", webArtifactDigest: "a".repeat(64),
      releaseManifestDigest: "b".repeat(64), certificationDigest: "c".repeat(64),
      launchProfileRef: "core-redeem-chat@1", siteConfigRevisionRef: "config_01",
      legalRevisionRef: "legal_01", featurePolicyRevision: "policy_01",
      modelOptionCatalogRef: "model_catalog_01", agentCatalogRef: "agent_catalog_01",
      identityIssuerLabel: "Image Studio", identityAuthStrengthPolicyRevision: "auth_policy_01",
      enabledSurfaceIds: ["account", "chat"],
      localePolicy: { defaultLocale: "en-US", allowedLocales: ["en-US"] },
    }, await context("site.release.publish"));

    expect(receipt).toEqual({ siteRef: "site_01", state: "ready", replayed: false });
    expect(calls).toEqual(["certify:release_01", "begin", "release:release_01", "succeed"]);
  });

  it("rejects expired certification before opening the owner transaction", async () => {
    let transactionOpened = false;
    const service = new SitePublicationService(new PlatformUnitOfWork({
      transaction: async () => { transactionOpened = true; throw new Error("unexpected"); },
    }), baseRepository(), { begin: async () => "fresh", succeed: async () => undefined }, {
      verify: async () => ({ status: "passed", expiresAt: "2026-07-28T11:59:59.000Z" }),
    }, { now: () => "2026-07-28T12:00:00.000Z" });
    await expect(service.publishRelease(releaseInput(), await context("site.release.publish")))
      .rejects.toThrow("SITE_RELEASE_CERTIFICATION_EXPIRED");
    expect(transactionOpened).toBe(false);
  });
});

function releaseInput() {
  return {
    commandId: "01983f57-8cf1-7000-8000-000000000011", idempotencyKey: "site-release-command-01",
    releaseRef: "release_01", siteRef: "site_01", webArtifactDigest: "a".repeat(64),
    releaseManifestDigest: "b".repeat(64), certificationDigest: "c".repeat(64),
    launchProfileRef: "core-redeem-chat@1", siteConfigRevisionRef: "config_01",
    legalRevisionRef: "legal_01", featurePolicyRevision: "policy_01",
    modelOptionCatalogRef: "model_catalog_01", agentCatalogRef: "agent_catalog_01",
    identityIssuerLabel: "Image Studio", identityAuthStrengthPolicyRevision: "auth_policy_01",
    enabledSurfaceIds: ["account", "chat"],
    localePolicy: { defaultLocale: "en-US", allowedLocales: ["en-US"] },
  } as const;
}

function baseRepository(): SiteAuthorityRepository & SitePublicationRepository {
  return {
    loadActiveProjectBindingForUpdate: async () => null,
    loadSiteForUpdate: async () => null, loadReleaseForUpdate: async () => null,
    loadActivationForUpdate: async () => null, insertActivation: async () => undefined,
    updateActivation: async () => undefined, commitActivation: async () => undefined,
    recordObservationAndCandidateDeployment: async () => undefined,
    updateSite: async () => undefined, insertSiteWithProjectBinding: async () => undefined,
    insertRelease: async () => undefined,
  };
}

function unitOfWork(): PlatformUnitOfWork {
  return new PlatformUnitOfWork({
    async transaction(_fence, work) {
      const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 0 });
      try { return await work(lease.transaction); } finally { revokePlatformTransaction(lease); }
    },
  }, () => "2026-07-28T12:00:30.000Z");
}

async function context(operation: string) {
  const issuer = "spiffe://kokoro.test";
  const input = {
    requestId: "request-01", correlationId: "correlation-01",
    trustedCaller: { kind: "admin_workload", workloadIdentityId: "admin-01", environment: "production",
      region: "us-east-1", audience: "platform-admin", allowedOperations: [operation], bindingEpoch: "1",
      issuedAt: "2026-07-28T12:00:00.000Z", expiresAt: "2026-07-28T12:10:00.000Z" },
    actor: { kind: "operator", subjectId: "operator-01", subjectGeneration: "1" }, delegatedGrant: null,
    target: { siteId: "site_01", workspaceId: null, projectId: null, purpose: operation, scopes: [operation] },
    audience: "platform-admin", environment: "production", region: "us-east-1",
    evidence: [{ kind: "workload_attestation", evidenceId: "attestation-01", issuer }], policyEpoch: "1",
    issuedAt: "2026-07-28T12:00:00.000Z", expiresAt: "2026-07-28T12:10:00.000Z",
  } as const;
  return verifyRequestSecurityContext(input, { now: "2026-07-28T12:00:30.000Z", operation,
    expectedAudience: "platform-admin", expectedEnvironment: "production", expectedRegion: "us-east-1",
    callerVerifier: { verify: async () => ({ workloadIdentityId: "admin-01", kind: "admin_workload",
      audience: "platform-admin", environment: "production", region: "us-east-1", allowedOperations: [operation],
      siteId: null, bindingEpoch: "1", issuedAt: "2026-07-28T12:00:00.000Z",
      expiresAt: "2026-07-28T12:10:00.000Z", issuer, keyVersion: "test-1" }) } });
}
