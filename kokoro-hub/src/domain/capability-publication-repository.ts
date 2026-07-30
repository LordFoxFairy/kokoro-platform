import type {
  CapabilityCatalogSnapshot,
  FrozenCapabilityCatalogPublication,
} from "./capability-catalog.js";

export interface FreezeCapabilityCatalogCommand {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly publication: FrozenCapabilityCatalogPublication;
}

export type CatalogProjectionState = "pending" | "committed" | "rejected" | "outcome_unknown";

export interface CapabilityCatalogPublicationRecord {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly publication: FrozenCapabilityCatalogPublication;
  readonly recordedAt: string;
  readonly projectionState: CatalogProjectionState;
  readonly lastProjectionErrorCode?: string;
  readonly replayed: boolean;
}

export interface CapabilityProjectionDelivery extends CapabilityCatalogPublicationRecord {
  readonly leaseId: string;
  readonly attempt: number;
}

export interface CapabilityPublicationRepository {
  freeze(command: FreezeCapabilityCatalogCommand): Promise<CapabilityCatalogPublicationRecord>;
  get(input: Readonly<{
    commandId: string;
    idempotencyKey: string;
    requestDigest: string;
    siteId: string;
    siteReleaseRef: string;
  }>): Promise<CapabilityCatalogPublicationRecord | null>;
  findByAgentCatalogRef(agentCatalogRef: string): Promise<CapabilityCatalogPublicationRecord | null>;
  claimProjection(input: Readonly<{
    leaseId: string;
    now: string;
    leaseUntil: string;
  }>): Promise<CapabilityProjectionDelivery | null>;
  completeProjection(input: Readonly<{
    siteId: string;
    siteReleaseRef: string;
    leaseId: string;
    projectedAt: string;
  }>): Promise<void>;
  releaseProjection(input: Readonly<{
    siteId: string;
    siteReleaseRef: string;
    leaseId: string;
  }>): Promise<void>;
  deferProjection(input: Readonly<{
    siteId: string;
    siteReleaseRef: string;
    leaseId: string;
    state: "outcome_unknown" | "rejected";
    errorCode: string;
    nextAttemptAt?: string;
  }>): Promise<void>;
}

export interface CapabilityCatalogAuthority {
  assertCurrent(snapshot: CapabilityCatalogSnapshot): Promise<void>;
}
