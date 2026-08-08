import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import type { PlatformUnitOfWork } from "../../../../shared/unit-of-work/index.js";
import type { SiteAuthorityJournal } from "../contracts/site-authority-ports.js";
import type {
  SitePublicationAuthorityRepository,
  SiteReleaseEvidenceAdmissionPort,
} from "../contracts/site-publication-authority-ports.js";
import { createSiteAuthorityCommand } from "../site-command.js";
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
  ) {}

  recordEvidence(input: CommandInput & Readonly<{
    siteRef: string;
    candidate: CandidateAuthorityBinding;
    compiledWebManifest: ImmutableRevisionBinding;
    webArtifactProvenance: ImmutableRevisionBinding;
    webArtifactDigest: string;
    artifactInspectionEvidence: ImmutableRevisionBinding;
    journeyEvidence: ImmutableRevisionBinding;
    securityEvidence: ImmutableRevisionBinding;
    producerIdentityRef: string;
    reason: string;
  }>, context: VerifiedRequestSecurityContext) {
    workload(context, input.siteRef);
    const command = createSiteAuthorityCommand("site.release-evidence.publish", input.siteRef,
      input, context, effect(input));
    return this.unitOfWork.execute({ context, operation: command.operation }, async (transaction) => {
      const disposition = await this.journal.begin(transaction, command);
      const candidate = await this.repository.loadCandidate(transaction, input.candidate.ref);
      if (candidate === null || candidate.siteRef !== input.siteRef) {
        throw new Error("SITE_PUBLICATION_CANDIDATE_NOT_FOUND");
      }
      exactCandidate(candidate.binding, input.candidate);
      const existing = await this.repository.loadNode(transaction, "release-evidence",
        input.candidate.ref, input.candidate.version);
      if (disposition === "replay") return nodeReplay(existing, input);
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

function workload(context: VerifiedRequestSecurityContext, siteRef: string): void {
  if (context.trustedCaller.kind !== "platform_worker" || context.actor.kind !== "workload" ||
      context.target.siteId !== siteRef) throw new Error("SITE_PUBLICATION_ATTESTOR_SCOPE_REQUIRED");
}

function exactCandidate(left: CandidateAuthorityBinding, right: CandidateAuthorityBinding): void {
  if (left.ref !== right.ref || left.version !== right.version ||
      left.authorizationEpoch !== right.authorizationEpoch || left.digest !== right.digest) {
    throw new Error("SITE_PUBLICATION_CANDIDATE_BINDING_MISMATCH");
  }
}

function nodeReplay(
  existing: SitePublicationNode | null,
  input: Readonly<{ siteRef: string }>,
) {
  if (existing === null) throw new Error("SITE_PUBLICATION_NODE_REPLAY_CONFLICT");
  return Object.freeze({ binding: existing.binding, siteRef: input.siteRef,
    state: "published" as const, replayed: true });
}

function effect(input: object): Readonly<Record<string, unknown>> {
  return Object.freeze(Object.fromEntries(Object.entries(input).filter(([key]) =>
    key !== "commandId" && key !== "idempotencyKey")));
}
