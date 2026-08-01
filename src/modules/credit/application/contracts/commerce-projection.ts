import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";

export type CreditOutboxCommitment = Readonly<{
  eventId: string;
  siteId: string;
  authorizationSegmentRef: string;
  operationKind: "reserve_root" | "finalize_segment" | "release_segment" | "reconcile_segment";
  result: unknown;
}>;

/** Credit-owned verification used by the shared Commerce delivery worker. */
export interface CreditOutboxProjectionPort {
  assertDeliverable(transaction: PlatformTransaction, event: CreditOutboxCommitment): Promise<void>;
}
