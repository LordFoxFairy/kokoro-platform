import type { MessageInitShape } from "@bufbuild/protobuf";
import type { VerifiedGaRunRequestOwnerFacts } from "./ga-run-request-draft-factory.js";
import type {
  AdmissionDenialSchema,
  AdmissionOutcomeUnknownSchema,
  AdmissionPendingSchema,
  AuthorizationExpiredSchema,
  AuthorizationNotReleasableSchema,
  AuthorizationReconciliationResultSchema,
  CommittedRunAuthorizationSchema,
  FinalizeRunAuthorizationEffect,
  PrepareRunEffect,
  PreparedRunAuthorizationSchema,
  ReconcileRunAuthorizationEffect,
  ReleasedRunAuthorizationSchema,
  ReleaseRunAuthorizationEffect,
} from "../../../generated/proto/kokoro/platform/admission/v1/admission_pb.js";

export type AdmissionOperationName =
  | "prepare_run"
  | "finalize_run_authorization"
  | "release_run_authorization"
  | "reconcile_run_authorization";

export interface AdmissionCaller {
  readonly identity: string;
  readonly environment: string;
  readonly region: string;
}

export interface AdmissionCommandKey extends AdmissionCaller {
  readonly siteId: string;
  readonly operation: AdmissionOperationName;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
}

export interface AdmissionReceiptLookup extends AdmissionCaller {
  readonly siteId: string;
  readonly operation: AdmissionOperationName;
  readonly commandId: string;
  readonly requestDigest: string;
}

export type AdmissionJournalBegin =
  | Readonly<{ kind: "started"; leaseToken: string }>
  | Readonly<{ kind: "pending"; recordedAt: string; retryAt: string }>
  | Readonly<{ kind: "replay"; response: Uint8Array }>;

export type AdmissionJournalLookup =
  | Readonly<{ kind: "not_found" }>
  | Readonly<{
      kind: "pending";
      idempotencyKey: string;
      recordedAt: string;
      retryAt: string;
    }>
  | Readonly<{ kind: "found"; response: Uint8Array }>;

/** Durable receipt storage. Implementations must fence completion with leaseToken. */
export interface AdmissionCommandJournal {
  begin(command: AdmissionCommandKey): Promise<AdmissionJournalBegin>;
  defer(command: AdmissionCommandKey, leaseToken: string, retryAt: string): Promise<string>;
  complete(
    command: AdmissionCommandKey,
    leaseToken: string,
    response: Uint8Array,
  ): Promise<Uint8Array>;
  lookup(query: AdmissionReceiptLookup): Promise<AdmissionJournalLookup>;
}

export interface AdmissionAuthorityCommand {
  readonly caller: AdmissionCaller;
  readonly siteId: string;
  readonly commandId: string;
  readonly requestDigest: string;
}

type Denied = Readonly<{
  kind: "denied";
  denial: MessageInitShape<typeof AdmissionDenialSchema>;
}>;
type Pending = Readonly<{
  kind: "pending";
  pending: MessageInitShape<typeof AdmissionPendingSchema>;
}>;
type OutcomeUnknown = Readonly<{
  kind: "outcome_unknown";
  unknown: MessageInitShape<typeof AdmissionOutcomeUnknownSchema>;
}>;

export type PrepareRunOwnerDecision =
  | Readonly<{
      kind: "accepted" | "waiting_prerequisite";
      ownerFacts: VerifiedGaRunRequestOwnerFacts;
      prepared: Omit<
        MessageInitShape<typeof PreparedRunAuthorizationSchema>,
        "runRequestMaterial"
      >;
      prerequisiteRefs: readonly string[];
    }>
  | Denied
  | Pending
  | OutcomeUnknown;

export type FinalizeRunOwnerDecision =
  | Readonly<{
      kind: "committed";
      committed: MessageInitShape<typeof CommittedRunAuthorizationSchema>;
    }>
  | Readonly<{
      kind: "expired";
      expired: MessageInitShape<typeof AuthorizationExpiredSchema>;
    }>
  | Denied
  | Pending
  | OutcomeUnknown;

export type ReleaseRunOwnerDecision =
  | Readonly<{
      kind: "released";
      released: MessageInitShape<typeof ReleasedRunAuthorizationSchema>;
    }>
  | Readonly<{
      kind: "already_released";
      released: MessageInitShape<typeof ReleasedRunAuthorizationSchema>;
    }>
  | Readonly<{
      kind: "not_releasable";
      notReleasable: MessageInitShape<typeof AuthorizationNotReleasableSchema>;
    }>
  | Pending
  | OutcomeUnknown;

export type ReconcileRunOwnerDecision =
  | Readonly<{
      kind:
        | "execution_observed"
        | "released_no_effect"
        | "awaiting_owner_evidence"
        | "reconciliation_required"
        | "settled";
      result: MessageInitShape<typeof AuthorizationReconciliationResultSchema>;
    }>
  | Pending
  | OutcomeUnknown;

/**
 * Trusted business-orchestration boundary. Only this adapter may assemble owner
 * facts (grant, Site release, model route, capabilities, assets, Hold and segment).
 * Session wire input is never treated as verified owner state.
 */
export interface AdmissionOwnerAuthority {
  prepareRun(
    command: AdmissionAuthorityCommand & Readonly<{ effect: PrepareRunEffect }>,
  ): Promise<PrepareRunOwnerDecision>;
  finalizeRunAuthorization(
    command: AdmissionAuthorityCommand & Readonly<{ effect: FinalizeRunAuthorizationEffect }>,
  ): Promise<FinalizeRunOwnerDecision>;
  releaseRunAuthorization(
    command: AdmissionAuthorityCommand & Readonly<{ effect: ReleaseRunAuthorizationEffect }>,
  ): Promise<ReleaseRunOwnerDecision>;
  reconcileRunAuthorization(
    command: AdmissionAuthorityCommand & Readonly<{ effect: ReconcileRunAuthorizationEffect }>,
  ): Promise<ReconcileRunOwnerDecision>;
}
