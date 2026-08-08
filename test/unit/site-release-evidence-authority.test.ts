import { describe, expect, it, vi } from "vitest";
import { canonicalDigest, canonicalJson } from
  "../../src/modules/product-catalog/domain/canonical-product-document.js";
import { SiteReleaseEvidenceAuthorityService } from
  "../../src/modules/site/application/services/site-release-evidence-authority-service.js";
import type {
  CandidateAuthorityBinding,
  ImmutableRevisionBinding,
  SitePublicationNode,
  SiteReleaseCandidateAuthority,
} from "../../src/modules/site/domain/site-publication-authority.js";
import { verifyRequestSecurityContext } from
  "../../src/shared/security-context/request-security-context.js";
import {
  issuePlatformTransaction,
  revokePlatformTransaction,
} from "../../src/shared/unit-of-work/platform-transaction.js";
import { PlatformUnitOfWork } from "../../src/shared/unit-of-work/unit-of-work.js";

const digest = `sha256:${"a".repeat(64)}`;
const candidateBinding: CandidateAuthorityBinding = Object.freeze({
  ref: "candidate.alpha", version: 1n, authorizationEpoch: 7n, digest,
});
const revision = (ref: string): ImmutableRevisionBinding => Object.freeze({ ref, revision: 1n, digest });
const candidate: SiteReleaseCandidateAuthority = Object.freeze({
  binding: candidateBinding,
  siteRef: "site:alpha",
  environment: "production",
  launchProductProfile: revision("profile.alpha"),
  productSurfaceCatalog: revision("catalog.alpha"),
  businessBindingsDigest: digest,
  state: "authorized",
  document: Object.freeze({}),
  canonicalBytes: new Uint8Array(),
});
const intent: SitePublicationNode = Object.freeze({
  kind: "web-build-intent",
  binding: revision("intent.alpha"),
  candidate: candidateBinding,
  siteRef: candidate.siteRef,
  document: Object.freeze({}),
  canonicalBytes: new Uint8Array(),
});

describe("SiteReleaseEvidenceAuthorityService", () => {
  it("owns only the workload-attested evidence transaction", async () => {
    const inserted = vi.fn();
    const repository = {
      loadCandidate: async () => candidate,
      loadNode: async (_transaction: unknown, kind: string) =>
        kind === "web-build-intent" ? intent : null,
      insertNode: inserted,
    } as never;
    const evidenceBinding = revision("release-evidence.alpha");
    const evidenceDocument = Object.freeze({
      contract: "kokoro.site-release-evidence.v1",
      schemaRevision: "1",
      releaseEvidenceRef: evidenceBinding.ref,
      revision: evidenceBinding.revision.toString(),
      siteRef: candidate.siteRef,
      siteReleaseCandidate: wireCandidate(candidateBinding),
      webBuildIntent: wire(intent.binding),
    });
    const binding = Object.freeze({
      ...evidenceBinding,
      digest: canonicalDigest(evidenceDocument),
    });
    const service = new SiteReleaseEvidenceAuthorityService(
      unitOfWork(),
      repository,
      { begin: async () => "fresh", succeed: async () => undefined },
      { verify: async () => ({ binding, source: {
        parsedDocument: evidenceDocument,
        canonicalBytes: Buffer.from(canonicalJson(evidenceDocument)),
        digest: binding.digest,
      } }) },
    );

    await expect(service.recordEvidence({
      commandId: "018f1212-1212-7212-8212-121212121212",
      idempotencyKey: "site-evidence-idempotency-0001",
      siteRef: candidate.siteRef,
      candidate: candidateBinding,
      compiledWebManifest: revision("manifest.alpha"),
      webArtifactProvenance: revision("provenance.alpha"),
      webArtifactDigest: digest,
      artifactInspectionEvidence: revision("inspection.alpha"),
      journeyEvidence: revision("journey.alpha"),
      securityEvidence: revision("security.alpha"),
      producerIdentityRef: "producer.web-attestor",
      reason: "record verified release evidence",
    }, await context())).resolves.toMatchObject({
      binding,
      state: "published",
      replayed: false,
    });
    expect(inserted).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: "release-evidence", binding }),
      "workload-attested",
      "018f1212-1212-7212-8212-121212121212",
    );
    expect("publishRelease" in service).toBe(false);
    expect("authorizeCandidate" in service).toBe(false);
  });
});

function unitOfWork(): PlatformUnitOfWork {
  return new PlatformUnitOfWork({
    async transaction(_fence, work) {
      const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 0 });
      try { return await work(lease.transaction); } finally { revokePlatformTransaction(lease); }
    },
  }, () => "2026-08-02T12:00:00.000Z");
}

async function context() {
  const issuer = "kokoro:site-evidence-mtls-peer-registry";
  const input = {
    requestId: "018f1212-1212-7212-8212-121212121212",
    correlationId: "018f1212-1212-7212-8212-121212121212",
    trustedCaller: {
      kind: "platform_worker",
      workloadIdentityId: "spiffe://kokoro/site-evidence-attestor",
      siteId: candidate.siteRef,
      environment: "production",
      region: "us-east-1",
      audience: "kokoro.site-release-evidence-admission.v1",
      allowedOperations: ["site.release-evidence.publish"],
      bindingEpoch: "7",
      issuedAt: "2026-08-02T11:59:55.000Z",
      expiresAt: "2026-08-02T12:00:05.000Z",
    },
    actor: {
      kind: "workload",
      subjectId: "spiffe://kokoro/site-evidence-attestor",
      subjectGeneration: "7",
      environment: "production",
      region: "us-east-1",
    },
    delegatedGrant: null,
    target: {
      siteId: candidate.siteRef,
      workspaceId: null,
      projectId: null,
      purpose: "site.release-evidence.publish",
      scopes: ["site.release-evidence.publish"],
    },
    audience: "kokoro.site-release-evidence-admission.v1",
    environment: "production",
    region: "us-east-1",
    evidence: [{ kind: "workload-attestation", evidenceId: "workload-attestation.alpha", issuer }],
    policyEpoch: "7",
    issuedAt: "2026-08-02T11:59:55.000Z",
    expiresAt: "2026-08-02T12:00:05.000Z",
  } as const;
  return verifyRequestSecurityContext(input, {
    now: "2026-08-02T12:00:00.000Z",
    operation: "site.release-evidence.publish",
    expectedAudience: input.audience,
    expectedEnvironment: input.environment,
    expectedRegion: input.region,
    callerVerifier: { verify: async () => ({
      workloadIdentityId: input.trustedCaller.workloadIdentityId,
      kind: "platform_worker" as const,
      audience: input.audience,
      environment: input.environment,
      region: input.region,
      allowedOperations: ["site.release-evidence.publish"],
      siteId: candidate.siteRef,
      bindingEpoch: "7",
      issuedAt: input.trustedCaller.issuedAt,
      expiresAt: input.trustedCaller.expiresAt,
      issuer,
      keyVersion: "7",
    }) },
  });
}

function wire(value: ImmutableRevisionBinding) {
  return Object.freeze({ ref: value.ref, revision: value.revision.toString(), digest: value.digest });
}

function wireCandidate(value: CandidateAuthorityBinding) {
  return Object.freeze({ ref: value.ref, version: value.version.toString(),
    authorizationEpoch: value.authorizationEpoch.toString(), digest: value.digest });
}
