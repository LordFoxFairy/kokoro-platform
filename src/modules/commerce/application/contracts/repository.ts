import type { JsonValue } from "../../../../shared/outbox-inbox/receipt.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type { CommerceCommandIdentity } from "../../domain/command-identity.js";
import type { ActualFulfillmentOutput, FulfillmentOutputLine } from "../../domain/output-line.js";
import type { FrozenFulfillmentSnapshot, FulfillmentSourceIdentity } from "../../domain/fulfillment-source.js";

export interface CommerceReceiptSnapshot {
  readonly state: "pending" | "succeeded" | "failed" | "outcome_unknown";
  readonly result: JsonValue | null;
  readonly resultDigest: string | null;
}

export type CommerceCommandClaim =
  | { readonly disposition: "execute"; readonly commandId: string }
  | { readonly disposition: "in_progress"; readonly commandId: string; readonly receipt: CommerceReceiptSnapshot }
  | { readonly disposition: "replay"; readonly commandId: string; readonly receipt: CommerceReceiptSnapshot };

export interface CommerceTerminalOutcome {
  readonly state: "succeeded" | "failed";
  readonly result: JsonValue | null;
  readonly resultDigest: string;
}

export type FulfillmentOutputReceipt = Readonly<{
  kind: "subscription_term" | "entitlement_grant" | "credit_grant";
  outputLineId: string;
  outputOrdinal: number;
  occurrence: number;
  resourceRef: string;
  templateRevisionRef: string;
  outputVersion: 1;
  outputDigest: string;
}>;

export type FulfillmentReceipt = Readonly<{
  fulfillmentId: string;
  outputSetDigest: string;
  resultDigest: string;
  outputs: readonly FulfillmentOutputReceipt[];
}>;

export interface ClaimFulfillmentInput {
  readonly fulfillmentId: string;
  readonly commandId: string | null;
  readonly billingAccountId: string;
  readonly source: FulfillmentSourceIdentity;
  readonly snapshot: FrozenFulfillmentSnapshot;
}

export type FulfillmentClaim =
  | Readonly<{ disposition: "execute"; fulfillmentId: string }>
  | Readonly<{ disposition: "replay"; receipt: FulfillmentReceipt }>;

export interface CommerceRepository {
  claimCommand(transaction: PlatformTransaction, identity: CommerceCommandIdentity): Promise<CommerceCommandClaim>;
  completeCommand(transaction: PlatformTransaction, identity: CommerceCommandIdentity, outcome: CommerceTerminalOutcome): Promise<void>;
  claimFulfillment(transaction: PlatformTransaction, input: ClaimFulfillmentInput): Promise<FulfillmentClaim>;
  recordExpectedOutputPlan(transaction: PlatformTransaction, fulfillmentId: string, plan: readonly FulfillmentOutputLine[]): Promise<void>;
  recordActualOutputs(transaction: PlatformTransaction, fulfillmentId: string, outputs: readonly ActualFulfillmentOutput[], plan: readonly FulfillmentOutputLine[]): Promise<void>;
  completeFulfillment(transaction: PlatformTransaction, input: { readonly fulfillmentId: string; readonly outputSetDigest: string; readonly resultDigest: string }): Promise<void>;
  linkOutboxEvent(transaction: PlatformTransaction, commandId: string, eventId: string): Promise<void>;
  recordAudit(transaction: PlatformTransaction, input: { readonly auditId: string; readonly commandId: string; readonly siteId: string; readonly eventType: string; readonly payloadDigest: string }): Promise<void>;
}
