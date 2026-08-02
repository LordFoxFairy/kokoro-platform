import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type { ImmutableRevisionBinding } from "../../domain/site-publication-authority.js";

export interface DigestReference { readonly ref: string; readonly digest: string }
export interface AuthIdentityClosure {
  readonly identityIssuer: ImmutableRevisionBinding;
  readonly authenticationPolicy: ImmutableRevisionBinding;
  readonly authorizationPolicy: ImmutableRevisionBinding;
  readonly closureDigest: string;
}
export interface CommerceReleaseClosure {
  readonly offerRevisions: readonly ImmutableRevisionBinding[];
  readonly offerPriceRevisions: readonly ImmutableRevisionBinding[];
  readonly entitlementTemplateRevisions: readonly ImmutableRevisionBinding[];
  readonly creditProgramRevisions: readonly ImmutableRevisionBinding[];
  readonly closureDigest: string;
}
export interface HubReleaseClosure {
  readonly capabilityAssignment: ImmutableRevisionBinding;
  readonly capabilityCatalog: ImmutableRevisionBinding;
  readonly agentCatalog: ImmutableRevisionBinding;
  readonly closureDigest: string;
}
export interface SiteEffectiveAccessSnapshot {
  readonly webBuildMaterialBundle: ImmutableRevisionBinding;
  readonly siteConfig: ImmutableRevisionBinding;
  readonly legalPolicy: ImmutableRevisionBinding;
  readonly salesPolicy: ImmutableRevisionBinding;
  readonly assortmentPolicy: ImmutableRevisionBinding;
  readonly memoryPolicy: ImmutableRevisionBinding;
  readonly authIdentityClosure: AuthIdentityClosure;
  readonly commerceClosure: CommerceReleaseClosure;
  readonly hubClosure: HubReleaseClosure;
  readonly modelRequirements: readonly Readonly<{
    modelRoleRef: string;
    modelInventory: DigestReference;
    modelCatalog: DigestReference;
  }>[];
}

/** Local Platform application port. Implementations compose owner reads in the
 * same transaction/UoW; they must never call Platform through self-RPC. */
export interface SiteEffectiveAccessSnapshotPort {
  resolve(transaction: PlatformTransaction, input: Readonly<{
    siteRef: string;
    environment: string;
    launchProductProfile: ImmutableRevisionBinding;
    productSurfaceCatalog: ImmutableRevisionBinding;
  }>): Promise<SiteEffectiveAccessSnapshot>;
}
