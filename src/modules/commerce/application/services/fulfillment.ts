import { createHash } from "node:crypto";
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
import { commerceCanonicalJson } from "../../domain/canonical-json.js";
import type {
  ClaimFulfillmentInput,
  FulfillmentClaim,
  FulfillmentOutputReceipt,
  FulfillmentReceipt,
} from "../contracts/repository.js";

export type { FulfillmentOutputReceipt, FulfillmentReceipt } from "../contracts/repository.js";

export interface FulfillmentRepositoryPort {
  claimFulfillment(transaction: PlatformTransaction, input: ClaimFulfillmentInput): Promise<FulfillmentClaim>;
  recordExpectedOutputPlan(
    transaction: PlatformTransaction,
    fulfillmentId: string,
    plan: readonly FulfillmentOutputLine[],
  ): Promise<void>;
  recordActualOutputs(
    transaction: PlatformTransaction,
    fulfillmentId: string,
    outputs: readonly ActualFulfillmentOutput[],
    plan: readonly FulfillmentOutputLine[],
  ): Promise<void>;
  completeFulfillment(
    transaction: PlatformTransaction,
    input: Readonly<{ fulfillmentId: string; outputSetDigest: string; resultDigest: string }>,
  ): Promise<void>;
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
    outputs: readonly FulfillmentOutputReceipt[];
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
  fulfillmentProgramVersionRef: string;
  outputPlanDigest: string;
  acquisitionSnapshotDigest: string;
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
      fulfillmentProgramVersionRef: input.fulfillmentProgramVersionRef,
      outputPlanDigest: input.outputPlanDigest,
      acquisitionSnapshotDigest: input.acquisitionSnapshotDigest,
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

    await this.dependencies.repository.recordExpectedOutputPlan(transaction, input.fulfillmentId, outputPlan);
    const issued = await this.dependencies.issuer.issue(transaction, {
      fulfillmentId: input.fulfillmentId,
      commandId: input.commandId,
      billingAccountId: input.billingAccountId,
      source,
      snapshot,
      materialization: input.materialization,
    });
    await this.dependencies.repository.recordActualOutputs(
      transaction,
      input.fulfillmentId,
      issued.actual,
      outputPlan,
    );
    const outputs = Object.freeze(issued.outputs.map((output) => Object.freeze({ ...output })));
    const outputSetDigest = digest({ version: 1, outputs });
    const resultDigest = digest({
      version: 1,
      fulfillmentId: input.fulfillmentId,
      outputSetDigest,
      outputCount: outputs.length,
    });
    await this.dependencies.repository.completeFulfillment(transaction, {
      fulfillmentId: input.fulfillmentId,
      outputSetDigest,
      resultDigest,
    });
    return Object.freeze({ fulfillmentId: input.fulfillmentId, outputSetDigest, resultDigest, outputs });
  }
}

function digest(value: Parameters<typeof commerceCanonicalJson>[0]): string {
  return createHash("sha256").update(commerceCanonicalJson(value), "utf8").digest("hex");
}
