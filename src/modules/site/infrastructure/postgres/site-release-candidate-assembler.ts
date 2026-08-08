import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import { resolvePlatformTransaction } from
  "../../../../shared/unit-of-work/platform-transaction.js";
import { canonicalDigest, canonicalJson } from
  "../../../product-catalog/domain/canonical-product-document.js";
import type { SiteReleaseCandidateAssemblyPort } from
  "../../application/contracts/site-publication-authority-ports.js";
import type {
  SiteEffectiveAccessSnapshot,
  SiteEffectiveAccessSnapshotPort,
} from "../../application/contracts/site-effective-access-snapshot.js";
import type { ImmutableRevisionBinding } from "../../domain/site-publication-authority.js";

export class PostgresSiteReleaseCandidateAssembler implements SiteReleaseCandidateAssemblyPort {
  readonly #now: () => string;
  constructor(
    private readonly effectiveAccess: SiteEffectiveAccessSnapshotPort,
    options: Readonly<{ now?: () => string }> = {},
  ) { this.#now = options.now ?? (() => new Date().toISOString()); }

  async assemble(
    transaction: PlatformTransaction,
    input: Parameters<SiteReleaseCandidateAssemblyPort["assemble"]>[1],
  ) {
    await assertProductAuthority(transaction, input.launchProductProfile,
      input.productSurfaceCatalog);
    const snapshot = await this.effectiveAccess.resolve(transaction, input);
    const document = Object.freeze({
      contract: "kokoro.site-release-candidate.v1",
      schemaRevision: "1",
      candidateRef: input.candidateRef,
      revision: input.expectedCandidateVersion.toString(),
      state: "authorized",
      siteRef: input.siteRef,
      environment: input.environment,
      candidateAuthorizationEpoch: input.candidateAuthorizationEpoch.toString(),
      launchProductProfile: wire(input.launchProductProfile),
      productSurfaceCatalog: wire(input.productSurfaceCatalog),
      businessBindings: businessBindings(snapshot),
      modelRequirements: [...snapshot.modelRequirements].sort((left, right) =>
        left.modelRoleRef.localeCompare(right.modelRoleRef)),
      createdAt: canonicalInstant(this.#now()),
    });
    const canonicalBytes = Buffer.from(canonicalJson(document), "utf8");
    return Object.freeze({ canonicalBytes, parsedDocument: document, digest: canonicalDigest(document) });
  }
}

async function assertProductAuthority(
  transaction: PlatformTransaction,
  profile: ImmutableRevisionBinding,
  catalog: ImmutableRevisionBinding,
): Promise<void> {
  const rows = await resolvePlatformTransaction(transaction).query<Record<string, unknown>>(
    `SELECT 1 FROM platform.launch_product_profile_revision profile
     JOIN platform.product_surface_catalog_revision catalog
       ON catalog.catalog_revision_ref=profile.catalog_revision_ref
      AND catalog.revision=profile.catalog_revision AND catalog.digest=profile.catalog_digest
     WHERE profile.profile_revision_ref=$1 AND profile.revision=$2::numeric(20,0)
       AND profile.digest=$3 AND catalog.catalog_revision_ref=$4
       AND catalog.revision=$5::numeric(20,0) AND catalog.digest=$6`,
    [profile.ref, profile.revision.toString(), profile.digest,
      catalog.ref, catalog.revision.toString(), catalog.digest],
  );
  if (rows.length !== 1) throw new Error("SITE_PUBLICATION_PRODUCT_AUTHORITY_NOT_FOUND");
}

function businessBindings(snapshot: SiteEffectiveAccessSnapshot) {
  return Object.freeze({
    webBuildMaterialBundle: wire(snapshot.webBuildMaterialBundle),
    siteConfig: wire(snapshot.siteConfig), legalPolicy: wire(snapshot.legalPolicy),
    salesPolicy: wire(snapshot.salesPolicy), assortmentPolicy: wire(snapshot.assortmentPolicy),
    memoryPolicy: wire(snapshot.memoryPolicy),
    authIdentityClosure: Object.freeze({
      identityIssuer: wire(snapshot.authIdentityClosure.identityIssuer),
      authenticationPolicy: wire(snapshot.authIdentityClosure.authenticationPolicy),
      authorizationPolicy: wire(snapshot.authIdentityClosure.authorizationPolicy),
      closureDigest: snapshot.authIdentityClosure.closureDigest,
    }),
    commerceClosure: Object.freeze({
      offerRevisions: sorted(snapshot.commerceClosure.offerRevisions),
      entitlementTemplateRevisions: sorted(snapshot.commerceClosure.entitlementTemplateRevisions),
      creditProgramRevisions: sorted(snapshot.commerceClosure.creditProgramRevisions),
      closureDigest: snapshot.commerceClosure.closureDigest,
    }),
    hubClosure: Object.freeze({
      capabilityAssignment: wire(snapshot.hubClosure.capabilityAssignment),
      capabilityCatalog: wire(snapshot.hubClosure.capabilityCatalog),
      agentCatalog: wire(snapshot.hubClosure.agentCatalog),
      closureDigest: snapshot.hubClosure.closureDigest,
    }),
  });
}
function sorted(values: readonly ImmutableRevisionBinding[]) {
  const sortedValues = [...values].sort((left, right) => left.ref.localeCompare(right.ref));
  if (sortedValues.some((value, index) => index > 0 && value.ref === sortedValues[index - 1]!.ref)) {
    throw new Error("SITE_PUBLICATION_EFFECTIVE_ACCESS_DUPLICATE");
  }
  return sortedValues.map(wire);
}
function wire(value: ImmutableRevisionBinding) {
  return Object.freeze({ ref: value.ref, revision: value.revision.toString(), digest: value.digest });
}
function canonicalInstant(value: string): string {
  if (!/^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$/u.test(value) ||
      new Date(value).toISOString() !== value) throw new Error("SITE_PUBLICATION_TIME_INVALID");
  return value;
}
