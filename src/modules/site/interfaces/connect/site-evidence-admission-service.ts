import { create } from "@bufbuild/protobuf";
import { createValidator } from "@bufbuild/protovalidate";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import {
  CommandDigestAlgorithmV2,
  CommandIdentityV2Schema,
  CommandReceiptStateV2,
  CommandReceiptV2Schema,
} from "../../../../generated/proto/kokoro/common/v2/command_envelope_pb.js";
import {
  ImmutableContractRevisionBindingSchema,
  type CandidateAuthorityBinding as WireCandidate,
  type ImmutableContractRevisionBinding as WireRevision,
} from "../../../../generated/proto/kokoro/platform/publication/v1/publication_common_pb.js";
import {
  SiteEvidenceAdmissionService as SiteEvidenceAdmissionDescriptor,
  RecordReleaseEvidenceRequestSchema,
  type AttestedReleaseEvidenceContext,
} from "../../../../generated/proto/kokoro/platform/site/v1/site_publication_pb.js";
import {
  recordReleaseEvidenceRequestDigest,
  type VerifiedReleaseEvidenceWorkloadAxes,
} from "../../../../generated/contracts/platform-site-evidence-admission@v1/digest.js";
import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import type { SiteReleaseEvidenceWorkloadRecord } from
  "../../application/contracts/site-release-evidence-records.js";
import type { SiteReleaseEvidenceAuthorityService } from
  "../../application/services/site-release-evidence-authority-service.js";
import type { CandidateAuthorityBinding, ImmutableRevisionBinding } from
  "../../domain/site-publication-authority.js";
import type { ControlCommandReceiptTimestampReader } from
  "../../../admin/infrastructure/postgres/control-command-receipt-reader.js";

export type SiteEvidenceAdmissionConnectService = ServiceImpl<typeof SiteEvidenceAdmissionDescriptor>;

/** Transport authenticator + authoritative live workload authorization reader. */
export interface SiteEvidenceAdmissionResolver {
  resolve(
    claimed: AttestedReleaseEvidenceContext,
    transport: HandlerContext,
    request: Readonly<{ siteRef: string; resourceRefs: readonly string[] }>,
  ): Promise<Readonly<{
    context: VerifiedRequestSecurityContext;
    axes: VerifiedReleaseEvidenceWorkloadAxes;
    workload: SiteReleaseEvidenceWorkloadRecord;
  }>>;
}

export function createSiteEvidenceAdmissionConnectService(input: Readonly<{
  owner: Pick<SiteReleaseEvidenceAuthorityService, "recordEvidence">;
  resolver: SiteEvidenceAdmissionResolver;
  receipts: ControlCommandReceiptTimestampReader;
}>): SiteEvidenceAdmissionConnectService {
  return {
    async recordReleaseEvidence(request, transport) {
      if (createValidator().validate(RecordReleaseEvidenceRequestSchema, request).kind !== "valid") {
        throw new ConnectError("SITE_EVIDENCE_REQUEST_INVALID", Code.InvalidArgument);
      }
      const claimed = required(request.context, "SITE_EVIDENCE_CONTEXT_REQUIRED");
      const effect = required(request.effect, "SITE_EVIDENCE_EFFECT_REQUIRED");
      const candidate = required(effect.candidate, "SITE_EVIDENCE_CANDIDATE_REQUIRED");
      const manifest = required(effect.compiledWebManifest, "SITE_EVIDENCE_MANIFEST_REQUIRED");
      const provenance = required(effect.webArtifactProvenance, "SITE_EVIDENCE_PROVENANCE_REQUIRED");
      const inspection = required(effect.artifactInspectionEvidence, "SITE_EVIDENCE_INSPECTION_REQUIRED");
      const journey = required(effect.journeyEvidence, "SITE_EVIDENCE_JOURNEY_REQUIRED");
      const security = required(effect.securityEvidence, "SITE_EVIDENCE_SECURITY_REQUIRED");
      const verified = await input.resolver.resolve(claimed, transport, {
        siteRef: request.siteId,
        resourceRefs: [candidate.candidateRef, manifest.ref, provenance.ref, inspection.ref,
          journey.ref, security.ref],
      });
      if (verified.context.trustedCaller.kind !== "platform_worker" ||
          verified.context.actor.kind !== "workload" ||
          verified.context.target.siteId !== request.siteId) {
        throw new ConnectError("SITE_EVIDENCE_WORKLOAD_SCOPE_REQUIRED", Code.PermissionDenied);
      }
      const identity = required(claimed.command, "SITE_EVIDENCE_COMMAND_REQUIRED");
      const verifiedRequestDigest = recordReleaseEvidenceRequestDigest(
        claimed,
        request.siteId,
        effect,
        verified.axes,
      );
      if (identity.digestAlgorithm !== CommandDigestAlgorithmV2.SHA256_COMMAND_ENVELOPE ||
          identity.requestDigest !== verifiedRequestDigest) {
        throw new ConnectError("SITE_EVIDENCE_REQUEST_DIGEST_MISMATCH", Code.InvalidArgument);
      }
      const result = await input.owner.recordEvidence({
        commandId: identity.commandId,
        idempotencyKey: identity.idempotencyKey,
        requestDigest: verifiedRequestDigest,
        siteRef: request.siteId,
        candidate: candidateBinding(candidate),
        compiledWebManifest: revision(manifest),
        webArtifactProvenance: revision(provenance),
        webArtifactDigest: effect.webArtifactDigest,
        artifactInspectionEvidence: revision(inspection),
        journeyEvidence: revision(journey),
        securityEvidence: revision(security),
        producerIdentityRef: claimed.producerIdentityRef,
        producerRegistration: revision(required(claimed.producerRegistration,
          "SITE_EVIDENCE_PRODUCER_REGISTRATION_REQUIRED")),
        provenanceAttestation: required(effect.provenanceAttestation,
          "SITE_EVIDENCE_PROVENANCE_ATTESTATION_REQUIRED"),
        evidenceDecisions: effect.evidenceDecisions,
        workload: verified.workload,
        reason: effect.reason,
      }, verified.context);
      const recordedAt = canonicalDate(await input.receipts.read(verified.context, {
        commandId: identity.commandId,
        operation: "site.release-evidence.publish",
      }));
      return {
        releaseEvidence: create(ImmutableContractRevisionBindingSchema, result.binding),
        replayed: result.replayed,
        receipt: create(CommandReceiptV2Schema, {
          identity: create(CommandIdentityV2Schema, identity),
          operation: "site.release-evidence.publish",
          state: CommandReceiptStateV2.COMMITTED,
          recordedAt: timestampFromDate(recordedAt),
        }),
      };
    },
  };
}

function revision(value: WireRevision): ImmutableRevisionBinding {
  return Object.freeze({ ref: value.ref, revision: value.revision, digest: value.digest });
}
function candidateBinding(value: WireCandidate): CandidateAuthorityBinding {
  return Object.freeze({ ref: value.candidateRef, version: value.candidateVersion,
    authorizationEpoch: value.candidateAuthorizationEpoch, digest: value.candidateDigest });
}
function required<T>(value: T | undefined, code: string): T {
  if (value === undefined) throw new ConnectError(code, Code.InvalidArgument);
  return value;
}
function canonicalDate(value: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== value) {
    throw new Error("SITE_EVIDENCE_RECEIPT_TIME_INVALID");
  }
  return date;
}
