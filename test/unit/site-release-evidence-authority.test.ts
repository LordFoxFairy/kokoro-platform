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
    const events: string[] = [];
    const inserted = vi.fn();
    const repository = {
      loadCandidate: async () => { events.push("candidate"); return candidate; },
      loadNode: async (_transaction: unknown, kind: string) => {
        events.push(`node:${kind}`);
        return kind === "web-build-intent" ? intent : null;
      },
      insertNode: async (...args: unknown[]) => { events.push("insert:node"); inserted(...args); },
    } as never;
    const records = {
      assertLiveWorkload: async () => { events.push("live"); },
      insertProvenance: async () => { events.push("insert:provenance"); },
      insertDecision: async () => { events.push("insert:decision"); },
      loadReplay: async () => null,
    };
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
      { begin: async (_transaction, command) => {
        events.push(`journal.begin:${command.requestDigest}`); return "fresh";
      }, succeed: async () => { events.push("journal.succeed"); } },
      { verify: async () => { events.push("verify"); return { binding, source: {
        parsedDocument: evidenceDocument,
        canonicalBytes: Buffer.from(canonicalJson(evidenceDocument)),
        digest: binding.digest,
      }, producer: producerTrust(), decisions: decisionRecords(),
      verifiedAt: "2026-08-02T12:00:00.000Z",
      provenanceCanonicalPayload: new TextEncoder().encode("{}") }; } },
      records as never,
    );

    const result = await service.recordEvidence({
      commandId: "018f1212-1212-7212-8212-121212121212",
      idempotencyKey: "site-evidence-idempotency-0001",
      requestDigest: "b".repeat(64),
      siteRef: candidate.siteRef,
      candidate: candidateBinding,
      compiledWebManifest: revision("manifest.alpha"),
      webArtifactProvenance: revision("provenance.alpha"),
      webArtifactDigest: digest,
      artifactInspectionEvidence: revision("inspection.alpha"),
      journeyEvidence: revision("journey.alpha"),
      securityEvidence: revision("security.alpha"),
      producerIdentityRef: "producer.web-attestor",
      producerRegistration: revision("producer-registration.alpha"),
      provenanceAttestation: { payloadType: "application/vnd.in-toto+json",
        keyId: "key.producer", keyVersion: 1n, signatureAlgorithm: 1,
        signature: new Uint8Array(64) } as never,
      evidenceDecisions: [] as never,
      workload: workloadRecord(),
      reason: "record verified release evidence",
    }, await context());
    expect(result).toMatchObject({
      binding,
      state: "published",
      replayed: false,
    });
    expect(result).not.toHaveProperty("recordedAt");
    expect(inserted).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: "release-evidence", binding }),
      "workload-attested",
      "018f1212-1212-7212-8212-121212121212",
    );
    expect("publishRelease" in service).toBe(false);
    expect("authorizeCandidate" in service).toBe(false);
    expect(events[0]).toBe(`journal.begin:${"b".repeat(64)}`);
    expect(events.indexOf("insert:node")).toBeLessThan(events.indexOf("insert:provenance"));
    expect(events.filter((event) => event === "insert:decision")).toHaveLength(3);
    expect(events.at(-1)).toBe("journal.succeed");
  });

  it("replays only a complete one-node one-provenance three-decision commit without writes", async () => {
    const writes = vi.fn();
    const replayBinding = revision("release-evidence.alpha");
    const service = new SiteReleaseEvidenceAuthorityService(
      unitOfWork(),
      { loadCandidate: async () => candidate, loadNode: async () => intent,
        insertNode: writes } as never,
      { begin: async () => "replay", succeed: writes } as never,
      { verify: writes } as never,
      { assertLiveWorkload: async () => undefined,
        loadReplay: async () => ({ binding: replayBinding,
          recordedAt: "2026-08-02T11:59:59.000Z" }),
        insertProvenance: writes, insertDecision: writes } as never,
    );
    const result = await service.recordEvidence(commandInput(), await context());
    expect(result).toMatchObject({ binding: replayBinding, replayed: true });
    expect(result).not.toHaveProperty("recordedAt");
    expect(writes).not.toHaveBeenCalled();
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

function commandInput() {
  return {
    commandId: "018f1212-1212-7212-8212-121212121212",
    idempotencyKey: "site-evidence-idempotency-0001", requestDigest: "b".repeat(64),
    siteRef: candidate.siteRef, candidate: candidateBinding,
    compiledWebManifest: revision("manifest.alpha"),
    webArtifactProvenance: revision("provenance.alpha"), webArtifactDigest: digest,
    artifactInspectionEvidence: revision("inspection.alpha"),
    journeyEvidence: revision("journey.alpha"), securityEvidence: revision("security.alpha"),
    producerIdentityRef: "producer.web-attestor",
    producerRegistration: revision("producer-registration.alpha"),
    provenanceAttestation: { payloadType: "application/vnd.in-toto+json",
      keyId: "key.producer", keyVersion: 1n, signatureAlgorithm: 1,
      signature: new Uint8Array(64) } as never,
    evidenceDecisions: [] as never, workload: workloadRecord(),
    reason: "record verified release evidence",
  };
}

function workloadRecord() {
  return Object.freeze({ siteProjectBindingRef: "binding.alpha",
    workloadIdentityRef: "spiffe://kokoro/site-evidence-attestor", siteRef: candidate.siteRef,
    environment: "production", region: "us-east-1", bindingEpoch: 7n,
    workloadAttestation: revision("workload-attestation.alpha"), workloadRevocationEpoch: 0n,
    liveRead: revision("live-read.alpha"), observedAt: "2026-08-02T11:59:59.000Z",
    validUntil: "2026-08-02T12:00:05.000Z" });
}

function producerTrust() {
  return { producerIdentityRef: "producer.web-attestor",
    producerRole: "web-artifact-provenance-attestor" as const,
    producerRegistration: revision("producer-registration.alpha"), producerRegistryEpoch: 1n,
    trustPolicy: revision("trust.producer"), trustPolicyEpoch: 1n,
    signingKeyId: "key.producer", signingKeyVersion: 1n, signingKeyFingerprint: digest,
    signatureDomain: "application/vnd.in-toto+json" as const, environment: "production",
    keyStatus: "active" as const, keyValidFrom: "2026-08-01T00:00:00.000Z",
    keyValidUntil: "2026-08-03T00:00:00.000Z", publicKeySpkiPem: "public-key",
    configurationDigest: "a".repeat(64) };
}

function decisionRecords() {
  return (["artifact-inspection", "journey", "security"] as const).map((kind) => ({
    environment: "production", role: kind, kind, checkerIdentityRef: `checker.${kind}`,
    checkerRegistration: revision(`registration.${kind}`), trustPolicy: revision(`trust.${kind}`),
    trustPolicyEpoch: 1n, signingKeyId: `key.${kind}`, signingKeyVersion: 1n,
    signingKeyFingerprint: digest,
    signatureDomain: "application/vnd.kokoro.release-evidence-decision.v1+json" as const,
    keyStatus: "active" as const, keyValidFrom: "2026-08-01T00:00:00.000Z",
    keyValidUntil: "2026-08-03T00:00:00.000Z", publicKeySpkiPem: "public-key",
    configurationDigest: "a".repeat(64), state: "passed" as const,
    evidence: revision(`${kind}.evidence`), canonicalPayload: new Uint8Array([1]),
    payloadDigest: digest, signature: new Uint8Array(64),
  }));
}
