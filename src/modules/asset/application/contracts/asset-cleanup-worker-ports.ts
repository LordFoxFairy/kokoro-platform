import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";

export type AssetCleanupObjectRole = "quarantine" | "trusted_copy";
export type AssetCleanupTerminalReservationState = "released" | "promoted";

export interface AssetObjectCleanup {
  readonly cleanupRef: string;
  readonly cleanupGroupRef: string;
  readonly siteRef: string;
  readonly intentRef: string;
  readonly sessionRef: string;
  readonly storageTenantRef: string;
  readonly storageRegion: string;
  readonly objectRole: AssetCleanupObjectRole;
  readonly objectRef: string;
  readonly providerVersionRef: string;
  readonly retainedBytes: bigint;
  readonly state: "pending_delete" | "deleting" | "delete_unavailable" | "completed";
  readonly expectedVersion: bigint;
}

export type AssetCleanupWork =
  | Readonly<{ disposition: "work"; cleanup: AssetObjectCleanup }>
  | Readonly<{ disposition: "terminal" | "superseded" }>;

export interface AssetCleanupGroupPlan {
  readonly cleanupGroupRef: string;
  readonly terminalReservationState: AssetCleanupTerminalReservationState;
  readonly targets: readonly Readonly<{
    cleanupRef: string;
    objectRole: AssetCleanupObjectRole;
    storageTenantRef: string;
    storageRegion: string;
    objectRef: string;
    providerVersionRef: string;
    retainedBytes: bigint;
    cleanupEvent: import("../../../../shared/outbox-inbox/outbox.js").OutboxEvent;
  }>[];
}

export interface AssetObjectCleanupRepositoryPort {
  claimCleanupWork(
    transaction: PlatformTransaction,
    input: Readonly<{
      eventId: string;
      siteRef: string;
      cleanupRef: string;
      expectedVersion: bigint;
    }>,
  ): Promise<AssetCleanupWork>;
  markCleanupRetry(
    transaction: PlatformTransaction,
    input: Readonly<{
      siteRef: string;
      cleanupRef: string;
      expectedVersion: bigint;
      reasonCode: string;
    }>,
  ): Promise<"committed" | "superseded">;
  completeCleanup(
    transaction: PlatformTransaction,
    input: Readonly<{
      cleanup: AssetObjectCleanup;
      expectedCleanupVersion: bigint;
      receiptRef: string;
      deletion: Extract<AssetObjectDeleteResult, { disposition: "confirmed_absent" }>;
    }>,
  ): Promise<"committed" | "superseded">;
}

export type AssetObjectDeleteResult =
  | Readonly<{
    disposition: "confirmed_absent";
    providerDisposition: "deleted" | "already_absent" | "absent_after_unknown";
    observedAt: string;
  }>
  | Readonly<{ disposition: "retry"; code: "ASSET_OBJECT_DELETE_OUTCOME_UNKNOWN" }>;

export interface AssetObjectCleanupStorePort {
  deleteExact(input: Readonly<{
    storageTenantRef: string;
    storageRegion: string;
    objectRef: string;
    providerVersionRef: string;
    expectedSize: bigint;
  }>): Promise<AssetObjectDeleteResult>;
}
