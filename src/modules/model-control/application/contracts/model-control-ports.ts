import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type {
  CanonicalModelInventory,
  CanonicalizedModelInventory,
  ModelProduct,
  ModelRouteRole,
} from "../../domain/model-catalog.js";
import type {
  CanonicalizedSiteModelPolicy,
  SiteModelPolicy,
} from "../../domain/site-model-policy.js";
import type { ProviderOperationalAvailability } from "../../domain/provider-availability.js";

export interface ModelInventoryImportReceipt {
  readonly importId: string;
  readonly digest: string;
  readonly replayed: boolean;
  readonly counts: CanonicalizedModelInventory["counts"];
}
export interface ModelInventoryActivationReceipt {
  readonly activationId: string;
  readonly importId: string;
  readonly targetDigest: string;
  readonly expectedRevision: string;
  readonly activatedRevision: string;
  readonly replayed: boolean;
}
export interface SiteModelPolicyChangeReceipt {
  readonly changeId: string;
  readonly policyDigest: string;
  readonly revision: string;
  readonly replayed: boolean;
}
export interface ModelProviderAvailabilityReportReceipt {
  readonly reportId: string;
  readonly providerKey: string;
  readonly appliedEpoch: string;
  readonly replayed: boolean;
}
export interface ModelCandidate {
  readonly modelKey: string;
  readonly bindingKey: string;
  readonly providerKey: string;
  readonly gatewayModelName: string;
  readonly executionBoundary: "model_gateway";
  readonly position: number;
  readonly bindingPriority: number;
  readonly providerPriority: number;
  readonly inputModalities: readonly string[];
  readonly outputModalities: readonly string[];
  readonly capabilities: readonly string[];
  readonly contextWindow: number | null;
  readonly providerStatus: "active" | "disabled";
  readonly providerHealth: "unknown" | "healthy" | "degraded" | "down";
  readonly modelStatus: "active" | "disabled";
  readonly bindingStatus: "active" | "disabled";
  readonly routeRequiredCapabilities: readonly string[];
}
export interface CandidateProjection {
  readonly inventoryDigest: string;
  readonly policyStatus: "enabled" | "disabled" | "missing";
  readonly policyRevision: string;
  readonly candidates: readonly ModelCandidate[];
}
export type SelectedModelRoute = Pick<
  ModelCandidate,
  "modelKey" | "bindingKey" | "gatewayModelName" | "executionBoundary"
>;
export interface ModelSelectionDecisionRecord {
  readonly decisionId: string;
  readonly decisionDigest: string;
  readonly siteId: string;
  readonly product: ModelProduct;
  readonly role: ModelRouteRole;
  readonly requestDigest: string;
  readonly requiredCapabilities: readonly string[];
  readonly inventoryDigest: string;
  readonly policyRevision: string;
  readonly selectedModelKey: string | null;
  readonly selectedBindingKey: string | null;
  readonly selectedRoute: SelectedModelRoute | null;
  readonly candidateBindingKeys: readonly string[];
  readonly rejections: readonly {
    readonly modelKey: string;
    readonly bindingKey: string;
    readonly code: string;
  }[];
  readonly reason: string;
  readonly decidedAt: string;
}
export interface ResolveModelPolicyInput {
  readonly decisionId: string;
  readonly siteId: string;
  readonly product: ModelProduct;
  readonly role: ModelRouteRole;
  readonly requiredCapabilities: readonly string[];
}
export type ResolveModelPolicyResult =
  | {
      readonly kind: "selected";
      readonly selected: SelectedModelRoute;
      readonly inventoryDigest: string;
      readonly policyRevision: string;
      readonly reason: string;
    }
  | {
      readonly kind: "unavailable";
      readonly inventoryDigest: string;
      readonly policyRevision: string;
      readonly reason: string;
    };

export interface ModelControlRepository {
  importInventory(
    transaction: PlatformTransaction,
    input: {
      readonly importId: string;
      readonly importedBy: string;
      readonly inventory: CanonicalizedModelInventory;
      readonly providerAvailability: readonly ProviderOperationalAvailability[];
    },
  ): Promise<ModelInventoryImportReceipt>;
  activateInventory(
    transaction: PlatformTransaction,
    input: {
      readonly activationId: string;
      readonly activatedBy: string;
      readonly targetDigest: string;
      readonly expectedPointerRevision: string;
    },
  ): Promise<ModelInventoryActivationReceipt>;
  putSitePolicy(
    transaction: PlatformTransaction,
    input: {
      readonly changeId: string;
      readonly changedBy: string;
      readonly expectedRevision: string;
      readonly policy: CanonicalizedSiteModelPolicy;
    },
  ): Promise<SiteModelPolicyChangeReceipt>;
  reportProviderAvailability(
    transaction: PlatformTransaction,
    input: {
      readonly reportId: string;
      readonly providerKey: string;
      readonly status: ProviderOperationalAvailability["status"];
      readonly health: ProviderOperationalAvailability["health"];
      readonly expectedEpoch: string;
      readonly observationRef: string | null;
      readonly observedAt: string | null;
      readonly reportedBy: string;
    },
  ): Promise<ModelProviderAvailabilityReportReceipt>;
  loadCandidates(
    transaction: PlatformTransaction,
    input: ResolveModelPolicyInput,
  ): Promise<CandidateProjection>;
  findSelectionDecision(
    transaction: PlatformTransaction,
    decisionId: string,
  ): Promise<ModelSelectionDecisionRecord | null>;
  recordSelectionDecision(
    transaction: PlatformTransaction,
    decision: ModelSelectionDecisionRecord,
  ): Promise<ModelSelectionDecisionRecord>;
}
export interface ModelControlApplication {
  resolve(
    input: ResolveModelPolicyInput,
    context: VerifiedRequestSecurityContext,
  ): Promise<ResolveModelPolicyResult>;
}
export interface ModelInventoryImportAdministration {
  import(
    input: {
      readonly importId: string;
      readonly idempotencyKey?: string;
      readonly inventory: CanonicalModelInventory;
      readonly providerAvailability?: readonly ProviderOperationalAvailability[];
    },
    context: VerifiedRequestSecurityContext,
  ): Promise<ModelInventoryImportReceipt>;
}
export interface SiteModelPolicyAdministration {
  change(
    input: {
      readonly changeId: string;
      readonly idempotencyKey?: string;
      readonly expectedRevision: string;
      readonly policy: SiteModelPolicy;
    },
    context: VerifiedRequestSecurityContext,
  ): Promise<SiteModelPolicyChangeReceipt>;
}
export interface ModelInventoryActivationAdministration {
  activate(
    input: {
      readonly activationId: string;
      readonly idempotencyKey?: string;
      readonly targetDigest: string;
      readonly expectedPointerRevision: string;
    },
    context: VerifiedRequestSecurityContext,
  ): Promise<ModelInventoryActivationReceipt>;
}
export interface ModelProviderAvailabilityReporting {
  report(
    input: {
      readonly reportId: string;
      readonly providerKey: string;
      readonly status: ProviderOperationalAvailability["status"];
      readonly health: ProviderOperationalAvailability["health"];
      readonly expectedEpoch: string;
      readonly observationRef: string | null;
      readonly observedAt: string | null;
    },
    context: VerifiedRequestSecurityContext,
  ): Promise<ModelProviderAvailabilityReportReceipt>;
}
