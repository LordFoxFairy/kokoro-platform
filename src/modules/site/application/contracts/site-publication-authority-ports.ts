import type { ResolvedCanonicalDocument } from
  "../../../product-catalog/domain/canonical-product-document.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type {
  ImmutableRevisionBinding,
  SitePublicationNode,
  SitePublicationNodeKind,
  SiteReleaseCandidateAuthority,
} from "../../domain/site-publication-authority.js";

export interface SiteReleaseCandidateAssemblyPort {
  assemble(
    transaction: PlatformTransaction,
    input: Readonly<{
      siteRef: string;
      environment: string;
      candidateRef: string;
      expectedCandidateVersion: bigint;
      candidateAuthorizationEpoch: bigint;
      launchProductProfile: ImmutableRevisionBinding;
      productSurfaceCatalog: ImmutableRevisionBinding;
    }>,
  ): Promise<ResolvedCanonicalDocument>;
}

export interface SitePublicationDocumentResolver {
  resolve(input: Readonly<{
    kind: Exclude<SitePublicationNodeKind, "site-release">;
    binding: ImmutableRevisionBinding;
  }>): Promise<ResolvedCanonicalDocument>;
}

export interface SiteReleaseAssemblyPort {
  assemble(
    transaction: PlatformTransaction,
    input: Readonly<{
      candidate: SiteReleaseCandidateAuthority;
      predecessors: Readonly<Partial<Record<SitePublicationNodeKind, SitePublicationNode>>>;
    }>,
  ): Promise<Readonly<{ binding: ImmutableRevisionBinding; source: ResolvedCanonicalDocument }>>;
}

export interface SitePublicationAuthorityRepository {
  assertSiteCanPublish(
    transaction: PlatformTransaction,
    siteRef: string,
    environment: string,
  ): Promise<void>;
  loadCandidateForUpdate(
    transaction: PlatformTransaction,
    candidateRef: string,
  ): Promise<SiteReleaseCandidateAuthority | null>;
  insertCandidate(
    transaction: PlatformTransaction,
    candidate: SiteReleaseCandidateAuthority,
    commandId: string,
  ): Promise<void>;
  loadNodeForUpdate(
    transaction: PlatformTransaction,
    kind: SitePublicationNodeKind,
    candidateRef: string,
  ): Promise<SitePublicationNode | null>;
  insertNode(
    transaction: PlatformTransaction,
    node: SitePublicationNode,
    producerKind: "operator-approved" | "platform-issued" | "workload-attested" | "certifier-signed",
    commandId: string,
  ): Promise<void>;
}
