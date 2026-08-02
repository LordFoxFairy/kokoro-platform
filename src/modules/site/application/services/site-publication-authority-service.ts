import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import type { PlatformUnitOfWork } from "../../../../shared/unit-of-work/index.js";
import type { SiteAuthorityJournal } from "../contracts/site-authority-ports.js";
import type {
  SitePublicationAuthorityRepository,
  SitePublicationDocumentResolver,
  SiteReleaseAssemblyPort,
  SiteReleaseCandidateAssemblyPort,
} from "../contracts/site-publication-authority-ports.js";
import { createSiteAuthorityCommand } from "../site-command.js";
import {
  admitSitePublicationNode,
  authorizeSiteReleaseCandidate,
  type CandidateAuthorityBinding,
  type ImmutableRevisionBinding,
  type SitePublicationNode,
  type SitePublicationNodeKind,
} from "../../domain/site-publication-authority.js";

interface CommandInput { readonly commandId: string; readonly idempotencyKey: string }

export class SitePublicationAuthorityService {
  constructor(
    private readonly unitOfWork: PlatformUnitOfWork,
    private readonly repository: SitePublicationAuthorityRepository,
    private readonly journal: SiteAuthorityJournal,
    private readonly candidates: SiteReleaseCandidateAssemblyPort,
    private readonly documents: SitePublicationDocumentResolver,
    private readonly releases: SiteReleaseAssemblyPort,
  ) {}

  authorizeCandidate(input: CommandInput & Readonly<{
    siteRef: string;
    candidateRef: string;
    expectedCandidateVersion: bigint;
    candidateAuthorizationEpoch: bigint;
    launchProductProfile: ImmutableRevisionBinding;
    productSurfaceCatalog: ImmutableRevisionBinding;
    businessBindingsDigest: string;
    reason: string;
  }>, context: VerifiedRequestSecurityContext) {
    operator(context, input.siteRef);
    const command = createSiteAuthorityCommand("site.release-candidate.authorize", input.siteRef,
      input, context, effect(input));
    return this.unitOfWork.execute({ context, operation: command.operation }, async (transaction) => {
      const disposition = await this.journal.begin(transaction, command);
      const existing = await this.repository.loadCandidateForUpdate(transaction, input.candidateRef);
      if (disposition === "replay") return candidateReplay(existing, input);
      if (existing !== null) throw new Error("SITE_PUBLICATION_CANDIDATE_REF_CONFLICT");
      await this.repository.assertSiteCanPublish(transaction, input.siteRef, context.environment);
      const source = await this.candidates.assemble(transaction, {
        siteRef: input.siteRef, environment: context.environment, candidateRef: input.candidateRef,
        expectedCandidateVersion: input.expectedCandidateVersion,
        candidateAuthorizationEpoch: input.candidateAuthorizationEpoch,
        launchProductProfile: input.launchProductProfile,
        productSurfaceCatalog: input.productSurfaceCatalog,
      });
      const candidate = authorizeSiteReleaseCandidate({ ...input, environment: context.environment }, source);
      await this.repository.insertCandidate(transaction, candidate, command.commandId);
      const receipt = { siteRef: input.siteRef, state: candidate.state, replayed: false } as const;
      await this.journal.succeed(transaction, command, receipt, context);
      return Object.freeze({ candidate: candidate.binding, ...receipt });
    });
  }

  publishNode(input: CommandInput & Readonly<{
    siteRef: string;
    kind: Exclude<SitePublicationNodeKind, "site-release">;
    candidate: CandidateAuthorityBinding;
    binding: ImmutableRevisionBinding;
    reason: string;
    producerKind: "operator-approved" | "platform-issued" | "workload-attested" | "certifier-signed";
  }>, context: VerifiedRequestSecurityContext) {
    if (input.producerKind === "workload-attested") workload(context, input.siteRef);
    else operator(context, input.siteRef);
    const command = createSiteAuthorityCommand(`site.${input.kind}.publish`, input.siteRef,
      input, context, effect(input));
    return this.unitOfWork.execute({ context, operation: command.operation }, async (transaction) => {
      const disposition = await this.journal.begin(transaction, command);
      const candidate = await this.repository.loadCandidateForUpdate(transaction, input.candidate.ref);
      if (candidate === null || candidate.siteRef !== input.siteRef) {
        throw new Error("SITE_PUBLICATION_CANDIDATE_NOT_FOUND");
      }
      exactCandidate(candidate.binding, input.candidate);
      const existing = await this.repository.loadNodeForUpdate(transaction, input.kind,
        input.candidate.ref);
      if (disposition === "replay") return nodeReplay(existing, input);
      if (existing !== null) throw new Error("SITE_PUBLICATION_NODE_ALREADY_EXISTS");
      const predecessors = await this.predecessors(transaction, input.candidate.ref);
      const source = await this.documents.resolve({ kind: input.kind, binding: input.binding });
      const node = admitSitePublicationNode(input.kind, {
        binding: input.binding, source, candidate, predecessors,
      });
      await this.repository.insertNode(transaction, node, input.producerKind, command.commandId);
      const receipt = { siteRef: input.siteRef, state: "published", replayed: false } as const;
      await this.journal.succeed(transaction, command, receipt, context);
      return Object.freeze({ binding: node.binding, ...receipt });
    });
  }

  publishRelease(input: CommandInput & Readonly<{
    siteRef: string; candidate: CandidateAuthorityBinding; reason: string;
  }>, context: VerifiedRequestSecurityContext) {
    operator(context, input.siteRef);
    const command = createSiteAuthorityCommand("site.release.publish", input.siteRef,
      input, context, effect(input));
    return this.unitOfWork.execute({ context, operation: command.operation }, async (transaction) => {
      const disposition = await this.journal.begin(transaction, command);
      const candidate = await this.repository.loadCandidateForUpdate(transaction, input.candidate.ref);
      if (candidate === null || candidate.siteRef !== input.siteRef) {
        throw new Error("SITE_PUBLICATION_CANDIDATE_NOT_FOUND");
      }
      exactCandidate(candidate.binding, input.candidate);
      const existing = await this.repository.loadNodeForUpdate(transaction, "site-release",
        input.candidate.ref);
      if (disposition === "replay") return nodeReplay(existing, { ...input, kind: "site-release" });
      if (existing !== null) throw new Error("SITE_PUBLICATION_SITE_RELEASE_ALREADY_EXISTS");
      const predecessors = await this.predecessors(transaction, input.candidate.ref);
      const assembled = await this.releases.assemble(transaction, { candidate, predecessors });
      const node = admitSitePublicationNode("site-release", {
        binding: assembled.binding, source: assembled.source, candidate, predecessors,
      });
      await this.repository.insertNode(transaction, node, "platform-issued", command.commandId);
      const receipt = { siteRef: input.siteRef, state: "ready", replayed: false } as const;
      await this.journal.succeed(transaction, command, receipt, context);
      return Object.freeze({ binding: node.binding, ...receipt });
    });
  }

  private async predecessors(transaction: Parameters<SitePublicationAuthorityRepository["loadNodeForUpdate"]>[0], candidateRef: string) {
    const kinds: readonly SitePublicationNodeKind[] = ["surface-inventory", "web-build-material-bundle",
      "web-build-intent", "release-evidence", "release-certification"];
    const values = await Promise.all(kinds.map(async (kind) => [kind,
      await this.repository.loadNodeForUpdate(transaction, kind, candidateRef)] as const));
    return Object.fromEntries(values.filter((entry): entry is readonly [SitePublicationNodeKind, SitePublicationNode] =>
      entry[1] !== null));
  }
}

function operator(context: VerifiedRequestSecurityContext, siteRef: string): void {
  if (context.trustedCaller.kind !== "admin_workload" || context.actor.kind !== "operator" ||
      context.target.siteId !== siteRef) throw new Error("SITE_PUBLICATION_OPERATOR_SCOPE_REQUIRED");
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
function candidateReplay(existing: Awaited<ReturnType<SitePublicationAuthorityRepository["loadCandidateForUpdate"]>>,
  input: Readonly<{ candidateRef: string; siteRef: string; expectedCandidateVersion: bigint;
    candidateAuthorizationEpoch: bigint }>) {
  if (existing === null || existing.siteRef !== input.siteRef || existing.binding.ref !== input.candidateRef ||
      existing.binding.version !== input.expectedCandidateVersion ||
      existing.binding.authorizationEpoch !== input.candidateAuthorizationEpoch) {
    throw new Error("SITE_PUBLICATION_CANDIDATE_REPLAY_CONFLICT");
  }
  return Object.freeze({ candidate: existing.binding, siteRef: input.siteRef,
    state: existing.state, replayed: true });
}
function nodeReplay(existing: SitePublicationNode | null,
  input: Readonly<{ siteRef: string; kind: SitePublicationNodeKind; binding?: ImmutableRevisionBinding }>) {
  if (existing === null || (input.binding !== undefined &&
      (existing.binding.ref !== input.binding.ref || existing.binding.revision !== input.binding.revision ||
       existing.binding.digest !== input.binding.digest))) {
    throw new Error("SITE_PUBLICATION_NODE_REPLAY_CONFLICT");
  }
  return Object.freeze({ binding: existing.binding, siteRef: input.siteRef,
    state: input.kind === "site-release" ? "ready" : "published", replayed: true });
}
function effect(input: object): Readonly<Record<string, unknown>> {
  return Object.freeze(Object.fromEntries(Object.entries(input).filter(([key]) =>
    key !== "commandId" && key !== "idempotencyKey")));
}
