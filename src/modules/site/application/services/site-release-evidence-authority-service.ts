import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import type { PlatformUnitOfWork } from "../../../../shared/unit-of-work/index.js";
import type { SiteAuthorityJournal } from "../contracts/site-authority-ports.js";
import type {
  SiteReleaseEvidenceRecordRepositoryPort,
  SiteReleaseEvidenceWorkloadRecord,
} from "../contracts/site-release-evidence-records.js";
import type {
  SitePublicationAuthorityRepository,
  SiteReleaseEvidenceAdmissionPort,
} from "../contracts/site-publication-authority-ports.js";
import type {
  DetachedReleaseEvidenceAttestation,
  SignedReleaseEvidenceDecision,
} from "../../../../generated/proto/kokoro/platform/site/v1/site_publication_pb.js";
import { assertDigest, canonicalCommandId } from "../../../../shared/outbox-inbox/receipt.js";
import {
  admitSitePublicationNode,
  type CandidateAuthorityBinding,
  type ImmutableRevisionBinding,
  type SitePublicationNode,
  type SitePublicationNodeKind,
} from "../../domain/site-publication-authority.js";

interface CommandInput { readonly commandId: string; readonly idempotencyKey: string }

/** Dedicated machine authority; it intentionally exposes no operator publication capability. */
export class SiteReleaseEvidenceAuthorityService {
  constructor(
    private readonly unitOfWork: PlatformUnitOfWork,
    private readonly repository: SitePublicationAuthorityRepository,
    private readonly journal: SiteAuthorityJournal,
    private readonly evidence: SiteReleaseEvidenceAdmissionPort,
    private readonly records: SiteReleaseEvidenceRecordRepositoryPort,
  ) {}

  recordEvidence(input: CommandInput & Readonly<{
    siteRef: string;
    requestDigest: string;
    candidate: CandidateAuthorityBinding;
    compiledWebManifest: ImmutableRevisionBinding;
    webArtifactProvenance: ImmutableRevisionBinding;
    webArtifactDigest: string;
    artifactInspectionEvidence: ImmutableRevisionBinding;
    journeyEvidence: ImmutableRevisionBinding;
    securityEvidence: ImmutableRevisionBinding;
    producerIdentityRef: string;
    producerRegistration: ImmutableRevisionBinding;
    provenanceAttestation: DetachedReleaseEvidenceAttestation;
    evidenceDecisions: readonly SignedReleaseEvidenceDecision[];
    workload: SiteReleaseEvidenceWorkloadRecord;
    reason: string;
  }>, context: VerifiedRequestSecurityContext) {
    workload(context, input);
    const command = siteEvidenceCommand(input, context);
    return this.unitOfWork.execute({ context, operation: command.operation }, async (transaction) => {
      const disposition = await this.journal.begin(transaction, command);
      await this.records.assertLiveWorkload(transaction, input.workload);
      if (disposition === "replay") {
        const replay = await this.records.loadReplay(transaction, {
          commandId: command.commandId,
          candidate: input.candidate,
          siteRef: input.siteRef,
          environment: input.workload.environment,
          webArtifactDigest: input.webArtifactDigest,
          artifactInspectionEvidence: input.artifactInspectionEvidence,
          journeyEvidence: input.journeyEvidence,
          securityEvidence: input.securityEvidence,
        });
        if (replay === null) throw new Error("SITE_PUBLICATION_NODE_REPLAY_CONFLICT");
        return Object.freeze({ binding: replay.binding, siteRef: input.siteRef,
          state: "published" as const, replayed: true });
      }
      const candidate = await this.repository.loadCandidate(transaction, input.candidate.ref);
      if (candidate === null || candidate.siteRef !== input.siteRef) {
        throw new Error("SITE_PUBLICATION_CANDIDATE_NOT_FOUND");
      }
      exactCandidate(candidate.binding, input.candidate);
      const existing = await this.repository.loadNode(transaction, "release-evidence",
        input.candidate.ref, input.candidate.version);
      if (existing !== null) throw new Error("SITE_PUBLICATION_RELEASE_EVIDENCE_ALREADY_EXISTS");
      const predecessors = await loadPredecessors(this.repository, transaction, input.candidate);
      const verified = await this.evidence.verify(transaction, { ...input, candidate, predecessors });
      const node = admitSitePublicationNode("release-evidence", {
        binding: verified.binding,
        source: verified.source,
        candidate,
        predecessors,
      });
      await this.repository.insertNode(transaction, node, "workload-attested", command.commandId);
      const record = Object.freeze({
        requestDigest: command.requestDigest,
        commandId: command.commandId,
        admittedAt: verified.verifiedAt,
        siteRef: input.siteRef,
        environment: candidate.environment,
        candidate: candidate.binding,
        releaseEvidence: node.binding,
        compiledWebManifest: input.compiledWebManifest,
        provenance: input.webArtifactProvenance,
        provenanceCanonicalPayload: verified.provenanceCanonicalPayload,
        provenanceSignature: new Uint8Array(input.provenanceAttestation.signature),
        webArtifactDigest: input.webArtifactDigest,
        artifactInspectionEvidence: input.artifactInspectionEvidence,
        journeyEvidence: input.journeyEvidence,
        securityEvidence: input.securityEvidence,
        producer: verified.producer,
        workload: input.workload,
        decisions: verified.decisions,
      });
      await this.records.insertProvenance(transaction, record);
      for (const decision of verified.decisions) {
        await this.records.insertDecision(transaction, record, decision);
      }
      const receipt = { siteRef: input.siteRef, state: "published", replayed: false } as const;
      await this.journal.succeed(transaction, command, receipt, context);
      return Object.freeze({ binding: node.binding, ...receipt });
    });
  }
}

async function loadPredecessors(
  repository: SitePublicationAuthorityRepository,
  transaction: Parameters<SitePublicationAuthorityRepository["loadNode"]>[0],
  candidate: CandidateAuthorityBinding,
) {
  const kinds: readonly SitePublicationNodeKind[] = ["surface-inventory", "web-build-material-bundle",
    "web-build-intent", "release-evidence", "release-certification"];
  const values = await Promise.all(kinds.map(async (kind) => [kind,
    await repository.loadNode(transaction, kind, candidate.ref, candidate.version)] as const));
  return Object.fromEntries(values.filter((entry): entry is readonly [SitePublicationNodeKind, SitePublicationNode] =>
    entry[1] !== null));
}

function workload(
  context: VerifiedRequestSecurityContext,
  input: Readonly<{ siteRef: string; workload: SiteReleaseEvidenceWorkloadRecord }>,
): void {
  if (context.trustedCaller.kind !== "platform_worker" || context.actor.kind !== "workload" ||
      context.target.siteId !== input.siteRef || input.workload.siteRef !== input.siteRef ||
      input.workload.environment !== context.environment || input.workload.region !== context.region ||
      input.workload.workloadIdentityRef !== context.trustedCaller.workloadIdentityId ||
      input.workload.bindingEpoch.toString() !== context.trustedCaller.bindingEpoch ||
      input.workload.workloadRevocationEpoch !== 0n) {
    throw new Error("SITE_PUBLICATION_ATTESTOR_SCOPE_REQUIRED");
  }
}

function exactCandidate(left: CandidateAuthorityBinding, right: CandidateAuthorityBinding): void {
  if (left.ref !== right.ref || left.version !== right.version ||
      left.authorizationEpoch !== right.authorizationEpoch || left.digest !== right.digest) {
    throw new Error("SITE_PUBLICATION_CANDIDATE_BINDING_MISMATCH");
  }
}

function siteEvidenceCommand(
  input: Readonly<{ commandId: string; idempotencyKey: string; requestDigest: string; siteRef: string }>,
  context: VerifiedRequestSecurityContext,
) {
  assertDigest(input.requestDigest);
  if (input.idempotencyKey.length < 16 || input.idempotencyKey.length > 256) {
    throw new Error("SITE_IDEMPOTENCY_KEY_INVALID");
  }
  return Object.freeze({
    commandId: canonicalCommandId(input.commandId),
    idempotencyKey: input.idempotencyKey,
    operation: "site.release-evidence.publish",
    siteRef: input.siteRef,
    callerIdentity: context.trustedCaller.workloadIdentityId,
    environment: context.environment,
    region: context.region,
    requestDigest: input.requestDigest,
  });
}
