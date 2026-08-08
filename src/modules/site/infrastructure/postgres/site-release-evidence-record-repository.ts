import { resolvePlatformTransaction } from
  "../../../../shared/unit-of-work/platform-transaction.js";
import type {
  SiteReleaseEvidenceRecordRepositoryPort,
  VerifiedSiteReleaseEvidenceRecord,
} from "../../application/contracts/site-release-evidence-records.js";
import type { VerifiedSiteReleaseEvidenceDecision } from
  "../../application/contracts/site-release-evidence-trust.js";
import { digest, positiveDecimal, reference } from
  "./site-publication-authority-codecs.js";

interface ReplayRow extends Record<string, unknown> {
  readonly releaseEvidenceRef: unknown;
  readonly releaseEvidenceRevision: unknown;
  readonly releaseEvidenceDigest: unknown;
  readonly candidateRef: unknown;
  readonly candidateVersion: unknown;
  readonly candidateAuthorizationEpoch: unknown;
  readonly candidateDigest: unknown;
  readonly siteRef: unknown;
  readonly environment: unknown;
  readonly webArtifactDigest: unknown;
  readonly artifactInspectionEvidenceRef: unknown;
  readonly artifactInspectionEvidenceRevision: unknown;
  readonly artifactInspectionEvidenceDigest: unknown;
  readonly journeyEvidenceRef: unknown;
  readonly journeyEvidenceRevision: unknown;
  readonly journeyEvidenceDigest: unknown;
  readonly securityEvidenceRef: unknown;
  readonly securityEvidenceRevision: unknown;
  readonly securityEvidenceDigest: unknown;
  readonly decisionMaterialMatch: unknown;
  readonly nodeCount: unknown;
  readonly provenanceCount: unknown;
  readonly decisionCount: unknown;
  readonly artifactInspectionDecisionCount: unknown;
  readonly journeyDecisionCount: unknown;
  readonly securityDecisionCount: unknown;
}

export class PostgresSiteReleaseEvidenceRecordRepository
implements SiteReleaseEvidenceRecordRepositoryPort {
  async assertLiveWorkload(
    transaction: Parameters<SiteReleaseEvidenceRecordRepositoryPort["assertLiveWorkload"]>[0],
    input: Parameters<SiteReleaseEvidenceRecordRepositoryPort["assertLiveWorkload"]>[1],
  ): Promise<void> {
    const rows = await resolvePlatformTransaction(transaction).query<Readonly<{ active: boolean }>>(
      `SELECT TRUE AS active FROM platform.site_project_binding
       WHERE binding_ref=$1 AND site_ref=$2 AND environment=$3 AND region=$4
         AND workload_identity_id=$5 AND binding_epoch=$6::bigint AND state='active'
         AND clock_timestamp() < $7::timestamptz`,
      [input.siteProjectBindingRef, input.siteRef, input.environment, input.region,
        input.workloadIdentityRef, input.bindingEpoch.toString(), input.validUntil],
    );
    if (rows.length !== 1 || rows[0]?.active !== true) {
      throw new Error("SITE_EVIDENCE_WORKLOAD_AUTHORIZATION_REVOKED");
    }
  }

  async insertProvenance(
    transaction: Parameters<SiteReleaseEvidenceRecordRepositoryPort["insertProvenance"]>[0],
    input: Parameters<SiteReleaseEvidenceRecordRepositoryPort["insertProvenance"]>[1],
  ): Promise<void> {
    const producer = input.producer;
    const workload = input.workload;
    await resolvePlatformTransaction(transaction).execute(
      `INSERT INTO platform.site_release_provenance_attestation(
        provenance_ref,provenance_revision,provenance_digest,release_evidence_ref,
        release_evidence_revision,release_evidence_digest,candidate_ref,candidate_version,
        candidate_authorization_epoch,candidate_digest,site_ref,environment,
        compiled_web_manifest_ref,compiled_web_manifest_revision,compiled_web_manifest_digest,
        web_artifact_digest,artifact_inspection_evidence_ref,artifact_inspection_evidence_revision,
        artifact_inspection_evidence_digest,journey_evidence_ref,journey_evidence_revision,
        journey_evidence_digest,security_evidence_ref,security_evidence_revision,
        security_evidence_digest,producer_identity_ref,producer_role,producer_registration_ref,
        producer_registration_revision,producer_registration_digest,producer_registry_epoch,
        trust_policy_ref,trust_policy_revision,trust_policy_digest,trust_policy_epoch,
        signing_key_id,signing_key_version,signing_key_fingerprint,signature_domain,
        producer_configuration_digest,provenance_canonical_payload,provenance_payload_digest,
        provenance_signature,workload_identity_ref,workload_attestation_ref,
        workload_attestation_revision,workload_attestation_digest,workload_authorization_epoch,
        workload_revocation_epoch,workload_authorization_live_read_ref,
        workload_authorization_live_read_revision,workload_authorization_live_read_digest,
        workload_authorization_observed_at,workload_authorization_valid_until,request_digest,
        command_id,admitted_at)
       VALUES ($1,$2::numeric(20,0),$3,$4,$5::numeric(20,0),$6,$7,$8::numeric(20,0),
        $9::numeric(20,0),$10,$11,$12,$13,$14::numeric(20,0),$15,$16,$17,
        $18::numeric(20,0),$19,$20,$21::numeric(20,0),$22,$23,$24::numeric(20,0),$25,
        $26,$27,$28,$29::numeric(20,0),$30,$31::numeric(20,0),$32,$33::numeric(20,0),
        $34,$35::numeric(20,0),$36,$37::numeric(20,0),$38,$39,$40,$41,$42,$43,$44,
        $45,$46::numeric(20,0),$47,$48::numeric(20,0),$49::numeric(20,0),$50,
        $51::numeric(20,0),$52,$53::timestamptz,$54::timestamptz,$55,$56,$57::timestamptz)`,
      [input.provenance.ref, input.provenance.revision.toString(), input.provenance.digest,
        input.releaseEvidence.ref, input.releaseEvidence.revision.toString(), input.releaseEvidence.digest,
        input.candidate.ref, input.candidate.version.toString(),
        input.candidate.authorizationEpoch.toString(), input.candidate.digest, input.siteRef,
        input.environment, input.compiledWebManifest.ref, input.compiledWebManifest.revision.toString(),
        input.compiledWebManifest.digest, input.webArtifactDigest,
        input.artifactInspectionEvidence.ref, input.artifactInspectionEvidence.revision.toString(),
        input.artifactInspectionEvidence.digest, input.journeyEvidence.ref,
        input.journeyEvidence.revision.toString(), input.journeyEvidence.digest,
        input.securityEvidence.ref, input.securityEvidence.revision.toString(),
        input.securityEvidence.digest, producer.producerIdentityRef, producer.producerRole,
        producer.producerRegistration.ref, producer.producerRegistration.revision.toString(),
        producer.producerRegistration.digest, producer.producerRegistryEpoch.toString(),
        producer.trustPolicy.ref, producer.trustPolicy.revision.toString(), producer.trustPolicy.digest,
        producer.trustPolicyEpoch.toString(), producer.signingKeyId,
        producer.signingKeyVersion.toString(), producer.signingKeyFingerprint,
        producer.signatureDomain, producer.configurationDigest, input.provenanceCanonicalPayload,
        input.provenance.digest, input.provenanceSignature, workload.workloadIdentityRef,
        workload.workloadAttestation.ref, workload.workloadAttestation.revision.toString(),
        workload.workloadAttestation.digest, workload.bindingEpoch.toString(),
        workload.workloadRevocationEpoch.toString(), workload.liveRead.ref,
        workload.liveRead.revision.toString(), workload.liveRead.digest, workload.observedAt,
        workload.validUntil, input.requestDigest, input.commandId, input.admittedAt],
    );
  }

  async insertDecision(
    transaction: Parameters<SiteReleaseEvidenceRecordRepositoryPort["insertDecision"]>[0],
    input: VerifiedSiteReleaseEvidenceRecord,
    decision: VerifiedSiteReleaseEvidenceDecision,
  ): Promise<void> {
    await resolvePlatformTransaction(transaction).execute(
      `INSERT INTO platform.site_release_evidence_checker_decision(
        provenance_ref,provenance_revision,provenance_digest,evidence_kind,decision_state,
        candidate_ref,candidate_version,candidate_authorization_epoch,candidate_digest,site_ref,
        environment,web_artifact_digest,evidence_ref,evidence_revision,evidence_digest,
        checker_identity_ref,checker_registration_ref,checker_registration_revision,
        checker_registration_digest,checker_role,trust_policy_ref,trust_policy_revision,
        trust_policy_digest,trust_policy_epoch,signing_key_id,signing_key_version,
        signing_key_fingerprint,signature_domain,checker_configuration_digest,
        decision_canonical_payload,decision_payload_digest,decision_signature,command_id,decided_at)
       VALUES ($1,$2::numeric(20,0),$3,$4,'passed',$5,$6::numeric(20,0),
        $7::numeric(20,0),$8,$9,$10,$11,$12,$13::numeric(20,0),$14,$15,$16,
        $17::numeric(20,0),$18,$19,$20,$21::numeric(20,0),$22,$23::numeric(20,0),$24,
        $25::numeric(20,0),$26,$27,$28,$29,$30,$31,$32,$33::timestamptz)`,
      [input.provenance.ref, input.provenance.revision.toString(), input.provenance.digest,
        decision.kind, input.candidate.ref, input.candidate.version.toString(),
        input.candidate.authorizationEpoch.toString(), input.candidate.digest, input.siteRef,
        input.environment, input.webArtifactDigest, decision.evidence.ref,
        decision.evidence.revision.toString(), decision.evidence.digest, decision.checkerIdentityRef,
        decision.checkerRegistration.ref, decision.checkerRegistration.revision.toString(),
        decision.checkerRegistration.digest, decision.role, decision.trustPolicy.ref,
        decision.trustPolicy.revision.toString(), decision.trustPolicy.digest,
        decision.trustPolicyEpoch.toString(), decision.signingKeyId,
        decision.signingKeyVersion.toString(), decision.signingKeyFingerprint,
        decision.signatureDomain, decision.configurationDigest, decision.canonicalPayload,
        decision.payloadDigest, decision.signature, input.commandId, input.admittedAt],
    );
  }

  async loadReplay(
    transaction: Parameters<SiteReleaseEvidenceRecordRepositoryPort["loadReplay"]>[0],
    input: Parameters<SiteReleaseEvidenceRecordRepositoryPort["loadReplay"]>[1],
  ) {
    const rows = await resolvePlatformTransaction(transaction).query<ReplayRow>(
      `SELECT publication.revision_ref AS "releaseEvidenceRef",
              publication.revision::text AS "releaseEvidenceRevision",
              publication.digest AS "releaseEvidenceDigest",
              provenance.candidate_ref AS "candidateRef",
              provenance.candidate_version::text AS "candidateVersion",
              provenance.candidate_authorization_epoch::text AS "candidateAuthorizationEpoch",
              provenance.candidate_digest AS "candidateDigest",
              provenance.site_ref AS "siteRef",provenance.environment,
              provenance.web_artifact_digest AS "webArtifactDigest",
              provenance.artifact_inspection_evidence_ref AS "artifactInspectionEvidenceRef",
              provenance.artifact_inspection_evidence_revision::text
                AS "artifactInspectionEvidenceRevision",
              provenance.artifact_inspection_evidence_digest AS "artifactInspectionEvidenceDigest",
              provenance.journey_evidence_ref AS "journeyEvidenceRef",
              provenance.journey_evidence_revision::text AS "journeyEvidenceRevision",
              provenance.journey_evidence_digest AS "journeyEvidenceDigest",
              provenance.security_evidence_ref AS "securityEvidenceRef",
              provenance.security_evidence_revision::text AS "securityEvidenceRevision",
              provenance.security_evidence_digest AS "securityEvidenceDigest",
              bool_and(decision.candidate_ref=provenance.candidate_ref
                AND decision.candidate_version=provenance.candidate_version
                AND decision.candidate_authorization_epoch=provenance.candidate_authorization_epoch
                AND decision.candidate_digest=provenance.candidate_digest
                AND decision.site_ref=provenance.site_ref
                AND decision.environment=provenance.environment
                AND decision.web_artifact_digest=provenance.web_artifact_digest
                AND decision.decision_state='passed'
                AND CASE decision.evidence_kind
                  WHEN 'artifact-inspection' THEN
                    decision.evidence_ref=provenance.artifact_inspection_evidence_ref
                    AND decision.evidence_revision=provenance.artifact_inspection_evidence_revision
                    AND decision.evidence_digest=provenance.artifact_inspection_evidence_digest
                  WHEN 'journey' THEN decision.evidence_ref=provenance.journey_evidence_ref
                    AND decision.evidence_revision=provenance.journey_evidence_revision
                    AND decision.evidence_digest=provenance.journey_evidence_digest
                  WHEN 'security' THEN decision.evidence_ref=provenance.security_evidence_ref
                    AND decision.evidence_revision=provenance.security_evidence_revision
                    AND decision.evidence_digest=provenance.security_evidence_digest
                  ELSE FALSE
                END) AS "decisionMaterialMatch",
              count(DISTINCT publication.revision_ref)::text AS "nodeCount",
              count(DISTINCT provenance.provenance_ref)::text AS "provenanceCount",
              count(DISTINCT decision.evidence_kind)::text AS "decisionCount",
              count(*) FILTER (WHERE decision.evidence_kind='artifact-inspection')::text
                AS "artifactInspectionDecisionCount",
              count(*) FILTER (WHERE decision.evidence_kind='journey')::text
                AS "journeyDecisionCount",
              count(*) FILTER (WHERE decision.evidence_kind='security')::text
                AS "securityDecisionCount"
       FROM platform.site_publication_revision publication
       JOIN platform.site_release_provenance_attestation provenance
         ON provenance.release_evidence_ref=publication.revision_ref
        AND provenance.release_evidence_revision=publication.revision
        AND provenance.release_evidence_digest=publication.digest
        AND provenance.command_id=publication.command_id
       JOIN platform.site_release_evidence_checker_decision decision
         ON decision.provenance_ref=provenance.provenance_ref
        AND decision.provenance_revision=provenance.provenance_revision
        AND decision.provenance_digest=provenance.provenance_digest
        AND decision.command_id=provenance.command_id
       WHERE publication.publication_kind='release-evidence' AND publication.command_id=$1
         AND publication.candidate_ref=$2 AND publication.candidate_version=$3::numeric(20,0)
       GROUP BY publication.revision_ref,publication.revision,publication.digest,
         provenance.candidate_ref,provenance.candidate_version,
         provenance.candidate_authorization_epoch,provenance.candidate_digest,
         provenance.site_ref,provenance.environment,provenance.web_artifact_digest,
         provenance.artifact_inspection_evidence_ref,
         provenance.artifact_inspection_evidence_revision,
         provenance.artifact_inspection_evidence_digest,provenance.journey_evidence_ref,
         provenance.journey_evidence_revision,provenance.journey_evidence_digest,
         provenance.security_evidence_ref,provenance.security_evidence_revision,
         provenance.security_evidence_digest
       HAVING count(DISTINCT publication.revision_ref)=1
          AND count(DISTINCT provenance.provenance_ref)=1
          AND count(DISTINCT decision.evidence_kind)=3
          AND count(*) FILTER (WHERE decision.evidence_kind='artifact-inspection')=1
          AND count(*) FILTER (WHERE decision.evidence_kind='journey')=1
          AND count(*) FILTER (WHERE decision.evidence_kind='security')=1`,
      [input.commandId, input.candidate.ref, input.candidate.version.toString()],
    );
    if (rows.length === 0) return null;
    if (rows.length !== 1) throw new Error("SITE_EVIDENCE_REPLAY_SHAPE_INVALID");
    const row = rows[0]!;
    if (row.nodeCount !== "1" || row.provenanceCount !== "1" || row.decisionCount !== "3" ||
      row.artifactInspectionDecisionCount !== "1" || row.journeyDecisionCount !== "1" ||
      row.securityDecisionCount !== "1" || row.decisionMaterialMatch !== true ||
      !sameCandidate(row, input.candidate) ||
      reference(row.siteRef, "SITE_EVIDENCE_REPLAY_SHAPE_INVALID") !== input.siteRef ||
      row.environment !== input.environment ||
      digest(row.webArtifactDigest, "SITE_EVIDENCE_REPLAY_SHAPE_INVALID") !==
        input.webArtifactDigest ||
      !sameRevision(row, "artifactInspectionEvidence", input.artifactInspectionEvidence) ||
      !sameRevision(row, "journeyEvidence", input.journeyEvidence) ||
      !sameRevision(row, "securityEvidence", input.securityEvidence)) {
      throw new Error("SITE_EVIDENCE_REPLAY_SHAPE_INVALID");
    }
    return Object.freeze({
      binding: Object.freeze({
        ref: reference(row.releaseEvidenceRef, "SITE_EVIDENCE_REPLAY_SHAPE_INVALID"),
        revision: positiveDecimal(row.releaseEvidenceRevision, "SITE_EVIDENCE_REPLAY_SHAPE_INVALID"),
        digest: digest(row.releaseEvidenceDigest, "SITE_EVIDENCE_REPLAY_SHAPE_INVALID"),
      }),
    });
  }
}

function sameCandidate(
  row: ReplayRow,
  expected: Parameters<SiteReleaseEvidenceRecordRepositoryPort["loadReplay"]>[1]["candidate"],
): boolean {
  return reference(row.candidateRef, "SITE_EVIDENCE_REPLAY_SHAPE_INVALID") === expected.ref &&
    positiveDecimal(row.candidateVersion, "SITE_EVIDENCE_REPLAY_SHAPE_INVALID") === expected.version &&
    positiveDecimal(row.candidateAuthorizationEpoch, "SITE_EVIDENCE_REPLAY_SHAPE_INVALID") ===
      expected.authorizationEpoch &&
    digest(row.candidateDigest, "SITE_EVIDENCE_REPLAY_SHAPE_INVALID") === expected.digest;
}

function sameRevision(
  row: ReplayRow,
  prefix: "artifactInspectionEvidence" | "journeyEvidence" | "securityEvidence",
  expected: Parameters<SiteReleaseEvidenceRecordRepositoryPort["loadReplay"]>[1][
    "artifactInspectionEvidence"
  ],
): boolean {
  return reference(row[`${prefix}Ref`], "SITE_EVIDENCE_REPLAY_SHAPE_INVALID") === expected.ref &&
    positiveDecimal(row[`${prefix}Revision`], "SITE_EVIDENCE_REPLAY_SHAPE_INVALID") ===
      expected.revision &&
    digest(row[`${prefix}Digest`], "SITE_EVIDENCE_REPLAY_SHAPE_INVALID") === expected.digest;
}
