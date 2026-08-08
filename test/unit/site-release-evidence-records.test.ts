import { describe, expect, it } from "vitest";
import { PostgresSiteReleaseEvidenceRecordRepository } from
  "../../src/modules/site/infrastructure/postgres/site-release-evidence-record-repository.js";
import {
  issuePlatformTransaction,
  revokePlatformTransaction,
  type PlatformSqlTransaction,
} from "../../src/shared/unit-of-work/platform-transaction.js";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const binding = (ref: string, character = "a") => ({ ref, revision: 1n, digest: digest(character) });

class Sql implements PlatformSqlTransaction {
  readonly statements: string[] = [];
  readonly values: (readonly unknown[])[] = [];
  constructor(private readonly batches: readonly (readonly Record<string, unknown>[])[] = []) {}
  async query<Row extends Record<string, unknown>>(statement: string, values: readonly unknown[] = []) {
    this.statements.push(statement); this.values.push(values);
    return (this.batches[this.statements.length - 1] ?? []) as readonly Row[];
  }
  async execute(statement: string, values: readonly unknown[] = []) {
    this.statements.push(statement); this.values.push(values); return 1;
  }
}

describe("PostgresSiteReleaseEvidenceRecordRepository", () => {
  it("rereads the exact live workload then inserts provenance and three complete signed decisions", async () => {
    const sql = new Sql([[{ active: true }]]);
    const lease = issuePlatformTransaction(sql);
    const repository = new PostgresSiteReleaseEvidenceRecordRepository();
    const record = evidenceRecord();
    try {
      await repository.assertLiveWorkload(lease.transaction, record.workload);
      await repository.insertProvenance(lease.transaction, record);
      for (const decision of record.decisions) {
        await repository.insertDecision(lease.transaction, record, decision);
      }
      expect(sql.statements[0]).toContain("FROM platform.site_project_binding");
      expect(sql.statements[0]).toContain("binding_ref=$1");
      expect(sql.statements[0]).toContain("clock_timestamp() < $7::timestamptz");
      expect(sql.values[0]?.at(-1)).toBe(record.workload.validUntil);
      expect(sql.statements[1]).toContain("INSERT INTO platform.site_release_provenance_attestation");
      expect(sql.statements[1]).toContain("provenance_canonical_payload");
      expect(sql.statements[1]).toContain("configuration_digest");
      expect(sql.values[1]).toContain(record.requestDigest);
      for (const statement of sql.statements.slice(2)) {
        expect(statement).toContain("INSERT INTO platform.site_release_evidence_checker_decision");
        expect(statement).toContain("decision_canonical_payload");
        expect(statement).toContain("trust_policy_digest");
      }
      expect(sql.statements).toHaveLength(5);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("fails closed at the exclusive validity boundary after authorization", async () => {
    const sql = new Sql([[]]);
    const lease = issuePlatformTransaction(sql);
    const workload = evidenceRecord().workload;
    try {
      await expect(new PostgresSiteReleaseEvidenceRecordRepository().assertLiveWorkload(
        lease.transaction, workload,
      )).rejects.toThrow("SITE_EVIDENCE_WORKLOAD_AUTHORIZATION_REVOKED");
      expect(sql.statements[0]).toContain("clock_timestamp() < $7::timestamptz");
      expect(sql.values[0]?.at(-1)).toBe(workload.validUntil);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("accepts replay only when the same command owns one node, one provenance and three decisions", async () => {
    const record = evidenceRecord();
    const sql = new Sql([[replayRow(record)]]);
    const lease = issuePlatformTransaction(sql);
    try {
      await expect(new PostgresSiteReleaseEvidenceRecordRepository().loadReplay(
        lease.transaction, replayInput(record),
      )).resolves.toEqual({ binding: binding("release-evidence.alpha", "f") });
      expect(sql.statements[0]).toContain("HAVING count(DISTINCT publication.revision_ref)=1");
      expect(sql.statements[0]).toContain("count(DISTINCT provenance.provenance_ref)=1");
      expect(sql.statements[0]).toContain("count(DISTINCT decision.evidence_kind)=3");
      expect(sql.statements[0]).toContain("decision.evidence_kind='artifact-inspection'");
      expect(sql.statements[0]).toContain("decision.evidence_kind='journey'");
      expect(sql.statements[0]).toContain("decision.evidence_kind='security'");
      expect(sql.statements[0]).toContain('bool_and(decision.candidate_ref=provenance.candidate_ref');
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("rejects a replay row unless each checker kind is present exactly once", async () => {
    const record = evidenceRecord();
    const sql = new Sql([[replayRow(record, {
      artifactInspectionDecisionCount: "2", securityDecisionCount: "0",
    })]]);
    const lease = issuePlatformTransaction(sql);
    try {
      await expect(new PostgresSiteReleaseEvidenceRecordRepository().loadReplay(
        lease.transaction, replayInput(record),
      )).rejects.toThrow("SITE_EVIDENCE_REPLAY_SHAPE_INVALID");
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("rejects replay when provenance or checker material differs from the requested evidence", async () => {
    const record = evidenceRecord();
    for (const mutation of [
      { candidateDigest: digest("0") },
      { siteRef: "site.foreign" },
      { environment: "staging" },
      { webArtifactDigest: digest("0") },
      { artifactInspectionEvidenceDigest: digest("0") },
      { journeyEvidenceRevision: "2" },
      { securityEvidenceRef: "security.foreign" },
      { decisionMaterialMatch: false },
    ]) {
      const sql = new Sql([[replayRow(record, mutation)]]);
      const lease = issuePlatformTransaction(sql);
      try {
        await expect(new PostgresSiteReleaseEvidenceRecordRepository().loadReplay(
          lease.transaction, replayInput(record),
        )).rejects.toThrow("SITE_EVIDENCE_REPLAY_SHAPE_INVALID");
      } finally {
        revokePlatformTransaction(lease);
      }
    }
  });
});

function replayInput(record: ReturnType<typeof evidenceRecord>) {
  return {
    commandId: record.commandId,
    candidate: record.candidate,
    siteRef: record.siteRef,
    environment: record.environment,
    webArtifactDigest: record.webArtifactDigest,
    artifactInspectionEvidence: record.artifactInspectionEvidence,
    journeyEvidence: record.journeyEvidence,
    securityEvidence: record.securityEvidence,
  };
}

function replayRow(
  record: ReturnType<typeof evidenceRecord>,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    releaseEvidenceRef: record.releaseEvidence.ref,
    releaseEvidenceRevision: record.releaseEvidence.revision.toString(),
    releaseEvidenceDigest: record.releaseEvidence.digest,
    candidateRef: record.candidate.ref,
    candidateVersion: record.candidate.version.toString(),
    candidateAuthorizationEpoch: record.candidate.authorizationEpoch.toString(),
    candidateDigest: record.candidate.digest,
    siteRef: record.siteRef,
    environment: record.environment,
    webArtifactDigest: record.webArtifactDigest,
    artifactInspectionEvidenceRef: record.artifactInspectionEvidence.ref,
    artifactInspectionEvidenceRevision: record.artifactInspectionEvidence.revision.toString(),
    artifactInspectionEvidenceDigest: record.artifactInspectionEvidence.digest,
    journeyEvidenceRef: record.journeyEvidence.ref,
    journeyEvidenceRevision: record.journeyEvidence.revision.toString(),
    journeyEvidenceDigest: record.journeyEvidence.digest,
    securityEvidenceRef: record.securityEvidence.ref,
    securityEvidenceRevision: record.securityEvidence.revision.toString(),
    securityEvidenceDigest: record.securityEvidence.digest,
    decisionMaterialMatch: true,
    nodeCount: "1",
    provenanceCount: "1",
    decisionCount: "3",
    artifactInspectionDecisionCount: "1",
    journeyDecisionCount: "1",
    securityDecisionCount: "1",
    ...overrides,
  };
}

function evidenceRecord() {
  const candidate = { ref: "candidate.alpha", version: 1n,
    authorizationEpoch: 7n, digest: digest("b") };
  const producer = {
    producerIdentityRef: "producer.alpha", producerRole: "web-artifact-provenance-attestor" as const,
    producerRegistration: binding("producer.registration", "1"), producerRegistryEpoch: 2n,
    trustPolicy: binding("producer.trust", "2"), trustPolicyEpoch: 3n,
    signingKeyId: "producer.key", signingKeyVersion: 4n,
    signingKeyFingerprint: digest("3"), signatureDomain: "application/vnd.in-toto+json" as const,
    environment: "production", keyStatus: "active" as const,
    keyValidFrom: "2026-08-08T00:00:00.000Z", keyValidUntil: "2026-08-09T00:00:00.000Z",
    publicKeySpkiPem: "-----BEGIN PUBLIC KEY-----\n" + "A".repeat(80) + "\n-----END PUBLIC KEY-----\n",
    configurationDigest: "4".repeat(64),
  };
  const checker = (kind: "artifact-inspection" | "journey" | "security", character: string) => ({
    environment: "production", role: kind, kind, checkerIdentityRef: `checker.${kind}`,
    checkerRegistration: binding(`checker.registration.${kind}`, character),
    trustPolicy: binding(`checker.trust.${kind}`, character), trustPolicyEpoch: 5n,
    signingKeyId: `checker.key.${kind}`, signingKeyVersion: 6n,
    signingKeyFingerprint: digest(character),
    signatureDomain: "application/vnd.kokoro.release-evidence-decision.v1+json" as const,
    keyStatus: "active" as const, keyValidFrom: "2026-08-08T00:00:00.000Z",
    keyValidUntil: "2026-08-09T00:00:00.000Z", publicKeySpkiPem: producer.publicKeySpkiPem,
    configurationDigest: "5".repeat(64), state: "passed" as const,
    evidence: binding(`${kind}.evidence`, character),
    canonicalPayload: new TextEncoder().encode(`{"kind":"${kind}"}`),
    payloadDigest: digest(character), signature: new Uint8Array(64).fill(7),
  });
  return {
    requestDigest: "6".repeat(64), commandId: "018f1212-1212-7212-8212-121212121212",
    admittedAt: "2026-08-08T12:00:00.000Z", siteRef: "site.alpha", environment: "production",
    candidate, releaseEvidence: binding("release-evidence.alpha", "f"),
    compiledWebManifest: binding("manifest.alpha", "c"),
    provenance: binding("provenance.alpha", "d"),
    provenanceCanonicalPayload: new TextEncoder().encode("{}"),
    provenanceSignature: new Uint8Array(64).fill(9), webArtifactDigest: digest("e"),
    artifactInspectionEvidence: binding("artifact-inspection.evidence", "a"),
    journeyEvidence: binding("journey.evidence", "b"),
    securityEvidence: binding("security.evidence", "c"), producer,
    workload: {
      siteProjectBindingRef: "binding.alpha", workloadIdentityRef: "spiffe://kokoro/evidence/alpha",
      siteRef: "site.alpha", environment: "production", region: "us-east-1", bindingEpoch: 7n,
      workloadAttestation: binding("workload.attestation", "7"), workloadRevocationEpoch: 0n,
      liveRead: binding("workload.live-read", "8"),
      observedAt: "2026-08-08T11:59:59.000Z", validUntil: "2026-08-08T12:00:10.000Z",
    },
    decisions: [checker("artifact-inspection", "a"), checker("journey", "b"),
      checker("security", "c")],
  } as const;
}
