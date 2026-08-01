import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type { ActualFulfillmentOutput, FulfillmentOutputLine } from "../../domain/output-line.js";
import { compileFulfillmentOutputPlan } from "../../domain/output-line.js";
import {
  createFrozenFulfillmentSnapshot,
  createFulfillmentSourceIdentity,
  type FrozenFulfillmentSnapshot,
  type FulfillmentSourceIdentity,
  type FulfillmentSourceType,
} from "../../domain/fulfillment-source.js";
import type {
  ClaimFulfillmentInput,
  FulfillmentClaim,
  FulfillmentReceipt,
} from "../contracts/repository.js";

export type { FulfillmentOutputReceipt, FulfillmentReceipt } from "../contracts/repository.js";

export interface FulfillmentRepositoryPort {
  claimFulfillment(transaction: PlatformTransaction, input: ClaimFulfillmentInput): Promise<FulfillmentClaim>;
  commitFulfillment(transaction: PlatformTransaction, input: Readonly<{
    claim: ClaimFulfillmentInput;
    plan: readonly FulfillmentOutputLine[];
    outputs: readonly ActualFulfillmentOutput[];
  }>): Promise<FulfillmentReceipt>;
}

export interface FulfillmentIssuer<TMaterialization> {
  issue(
    transaction: PlatformTransaction,
    input: Readonly<{
      fulfillmentId: string;
      commandId: string;
      billingAccountId: string;
      source: FulfillmentSourceIdentity;
      snapshot: FrozenFulfillmentSnapshot;
      materialization: TMaterialization;
    }>,
  ): Promise<Readonly<{
    actual: readonly ActualFulfillmentOutput[];
  }>>;
}

export type FulfillmentExecutionInput<TMaterialization> = Readonly<{
  fulfillmentId: string;
  commandId: string;
  siteId: string;
  billingAccountId: string;
  sourceType: FulfillmentSourceType;
  sourceRef: string;
  purpose: string;
  cycleKey: string;
  productVersionRef: string;
  planVersionRef: string | null;
  offeringVersionRef: string;
  sourceVersion: bigint;
  sourceDigest: string;
  acquiredAt: string;
  fulfillmentProgramRevisionRef: string;
  fulfillmentProgramRevision: bigint;
  fulfillmentProgramDigest: string;
  pricingSnapshotRef: string | null;
  outputPlan: readonly FulfillmentOutputLine[];
  materialization: TMaterialization;
}>;

export class FulfillmentService<TMaterialization> {
  constructor(private readonly dependencies: Readonly<{
    repository: FulfillmentRepositoryPort;
    issuer: FulfillmentIssuer<TMaterialization>;
  }>) {}

  async execute(
    transaction: PlatformTransaction,
    input: FulfillmentExecutionInput<TMaterialization>,
  ): Promise<FulfillmentReceipt> {
    const source = createFulfillmentSourceIdentity(input);
    const snapshot = createFrozenFulfillmentSnapshot({
      sourceType: input.sourceType,
      productVersionRef: input.productVersionRef,
      planVersionRef: input.planVersionRef,
      offeringVersionRef: input.offeringVersionRef,
      sourceVersion: input.sourceVersion,
      sourceDigest: input.sourceDigest,
      acquiredAt: input.acquiredAt,
      fulfillmentProgramRevisionRef: input.fulfillmentProgramRevisionRef,
      fulfillmentProgramRevision: input.fulfillmentProgramRevision,
      fulfillmentProgramDigest: input.fulfillmentProgramDigest,
      pricingSnapshotRef: input.pricingSnapshotRef,
    });
    const outputPlan = compileFulfillmentOutputPlan(input.outputPlan);
    const claim = await this.dependencies.repository.claimFulfillment(transaction, {
      fulfillmentId: input.fulfillmentId,
      commandId: input.commandId,
      billingAccountId: input.billingAccountId,
      source,
      snapshot,
    });
    if (claim.disposition === "replay") return claim.receipt;
    if (claim.fulfillmentId !== input.fulfillmentId) throw new Error("FULFILLMENT_CLAIM_ID_MISMATCH");

    const issued = await this.dependencies.issuer.issue(transaction, {
      fulfillmentId: input.fulfillmentId,
      commandId: input.commandId,
      billingAccountId: input.billingAccountId,
      source,
      snapshot,
      materialization: input.materialization,
    });
    return this.dependencies.repository.commitFulfillment(transaction, {
      claim: { fulfillmentId: input.fulfillmentId, commandId: input.commandId,
        billingAccountId: input.billingAccountId, source, snapshot },
      plan: outputPlan,
      outputs: issued.actual,
    });
  }
}
