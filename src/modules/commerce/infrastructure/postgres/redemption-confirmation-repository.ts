import { createHash } from "node:crypto";
import type {
  RedemptionConfirmationRepository,
  RedemptionOutputReceipt,
  RedemptionReceiptRecord,
  StoredRedemptionConfirmation,
} from "../../application/contracts/redemption-confirmation-repository.js";
import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";
import { OutboxRepository } from "../../../../shared/outbox-inbox/outbox.js";
import type { CommerceRepository } from "../../application/contracts/repository.js";
import { PostgresCommerceRepository } from "./repository.js";
import type { FulfillmentService } from "../../application/services/fulfillment.js";
import {
  createPostgresFulfillmentService,
  fulfillmentCreditAccountIdentity,
  type FulfillmentOutputDefinition,
  type PostgresFulfillmentMaterialization,
  type PreparedFulfillmentSubscription,
} from "./fulfillment-issuer.js";
import {
  publishedFulfillmentOutputPlanDigest,
  isSupportedRedemptionSafeTerms,
  redemptionPreviewDigest,
  redemptionSafeTermsSchema,
  type RedemptionSafeTerms,
  uuidV7,
} from "../../domain/redemption-preview.js";
import { commerceCanonicalJson } from "../../domain/canonical-json.js";
import type { FulfillmentOutputLine } from "../../domain/output-line.js";
import { createFulfillmentSourceIdentity } from "../../domain/fulfillment-source.js";
import type { CommerceLockSequence } from "../../../../workflows/commerce/lock-order.js";
import type {
  CreditGrantIssuancePort,
  PreparedCreditGrantIssuance,
} from "../../../credit/application/contracts/grant-issuance.js";
import type { CreditGrantProgramPort } from "../../../credit/application/contracts/grant-program.js";
import type { CreditSourceCorrectionPort } from "../../../credit/application/contracts/source-correction.js";

type PreviewConfirmationRow = Record<string, unknown> & {
  previewRef: string;
  siteId: string;
  subjectId: string;
  subjectGeneration: bigint | string;
  billingAccountId: string;
  codeRef: string;
  batchRef: string;
  redemptionProgramRevisionRef: string;
  fulfillmentProgramRevisionRef: string;
  productRevisionDigest: string;
  programDigest: string;
  outputPlanDigest: string;
  previewDigest: string;
  credentialKeyRevision: string;
  credentialDigest: string;
  safeCodeFingerprint: string;
  safeTerms: unknown;
  state: "live" | "consumed" | "expired";
  expiresAt: Date | string;
  createdAt: Date | string;
};

type ProgramConfirmationRow = Record<string, unknown> & {
  availabilityState: "active" | "paused" | "retired";
  startsAt: Date | string | null;
  endsAt: Date | string | null;
  redemptionProgramRevisionRef: string;
  programDigest: string;
  maxRedemptionsPerAccount: number;
  productState: "active" | "disabled";
  productRef: string;
  productVersionRef: string;
  planRef: string | null;
  planVersionRef: string | null;
  productRevisionDigest: string;
  fulfillmentProgramRevisionRef: string;
  fulfillmentProgramRevision: bigint | string;
  outputPlanDigest: string;
  stackingScope: string | null;
  termAction: RedemptionSafeTerms["term"]["action"] | null;
  termSeconds: bigint | string | null;
};

type OutputRow = Record<string, unknown> & FulfillmentOutputDefinition;

type CommerceFulfillmentWriter = Pick<CommerceRepository,
  "claimFulfillment" | "commitFulfillment" | "linkOutboxEvent" | "recordAudit">;

type Dependencies = Readonly<{
  creditGrants: CreditGrantIssuancePort;
  creditPrograms: CreditGrantProgramPort;
  creditCorrections: CreditSourceCorrectionPort;
  commerce?: CommerceFulfillmentWriter;
  outbox?: Pick<OutboxRepository, "enqueue">;
  reference?: (purpose: string, ordinal: number, now: number) => string;
}>;

type ConfirmationCommandRow = Record<string, unknown> & {
  commandId: string;
  requestDigest: string;
  state: "pending" | "succeeded" | "failed" | "outcome_unknown";
  commandReceivedAt: Date | string;
  commandUpdatedAt: Date | string;
};

type RedemptionReceiptRow = Record<string, unknown> & {
  commandId: string;
  redemptionId: string;
  fulfillmentRef: string;
  outputSetDigest: string;
  planRef: string | null;
  planVersionRef: string | null;
  productRef: string;
  productVersionRef: string;
  redeemedAt: Date | string;
  safeCodeFingerprint: string;
  state: "fulfilled" | "reversed" | "reconciliation_required";
  stateObservedAt: Date | string;
  fulfillmentIdempotencyKey: string;
};

export class PostgresRedemptionConfirmationRepository implements RedemptionConfirmationRepository {
  readonly #commerce: CommerceFulfillmentWriter;
  readonly #fulfillment: FulfillmentService<PostgresFulfillmentMaterialization>;
  readonly #creditGrants: CreditGrantIssuancePort;
  readonly #creditPrograms: CreditGrantProgramPort;
  readonly #creditCorrections: CreditSourceCorrectionPort;
  readonly #outbox: Pick<OutboxRepository, "enqueue">;
  readonly #reference: NonNullable<Dependencies["reference"]>;

  constructor(dependencies: Dependencies) {
    this.#commerce = dependencies.commerce ?? new PostgresCommerceRepository();
    this.#creditGrants = dependencies.creditGrants;
    this.#creditPrograms = dependencies.creditPrograms;
    this.#creditCorrections = dependencies.creditCorrections;
    this.#fulfillment = createPostgresFulfillmentService(this.#commerce, this.#creditGrants);
    this.#outbox = dependencies.outbox ?? new OutboxRepository();
    this.#reference = dependencies.reference ?? ((_purpose, _ordinal, now) => uuidV7(now));
  }

  async confirmRedemption(
    transaction: Parameters<RedemptionConfirmationRepository["confirmRedemption"]>[0],
    input: Parameters<RedemptionConfirmationRepository["confirmRedemption"]>[1],
    locks: CommerceLockSequence,
  ): ReturnType<RedemptionConfirmationRepository["confirmRedemption"]> {
    const rows = await resolvePlatformTransaction(transaction).query<PreviewConfirmationRow>(PREVIEW_FOR_CONFIRM_SQL, [
      input.previewRef,
      input.siteId,
    ]);
    const preview = rows[0];
    if (preview === undefined || rows.length !== 1) return rejected();
    const safeTerms = redemptionSafeTermsSchema.parse(preview.safeTerms);
    if (!isSupportedRedemptionSafeTerms(safeTerms)) return rejected();
    if (!matchesConfirmationBinding(preview, safeTerms, input)) return rejected();
    const sql = resolvePlatformTransaction(transaction);
    locks.enter("program_availability");
    const programs = await sql.query<ProgramConfirmationRow>(PROGRAM_FOR_CONFIRM_SQL, [
      preview.redemptionProgramRevisionRef,
      input.siteId,
    ]);
    const program = programs[0];
    if (program === undefined || programs.length !== 1) return rejected();
    let catalogPlan: Readonly<{ planRef: string; state: "active" | "disabled" }> | null = null;
    if (safeTerms.planRef !== null) {
      const plans = await sql.query<Record<string, unknown> & { planRef: string; state: "active" | "disabled" }>(
        PLAN_FOR_CONFIRM_SQL,
        [input.siteId, safeTerms.planRef],
      );
      if (plans.length !== 1) return rejected();
      catalogPlan = Object.freeze(plans[0]!);
    }
    locks.enter("batch_availability");
    const batches = await sql.query<Record<string, unknown> & {
      state: "draft" | "active" | "paused" | "retired";
      startsAt: Date | string | null;
      endsAt: Date | string | null;
      redemptionProgramRevisionRef: string;
    }>(BATCH_FOR_CONFIRM_SQL, [preview.batchRef, input.siteId]);
    const batch = batches[0];
    if (batch === undefined || batches.length !== 1) return rejected();
    locks.enter("code");
    const codes = await sql.query<Record<string, unknown> & {
      state: "available" | "claimed" | "void";
      batchRef: string;
      safeCodeFingerprint: string;
    }>(CODE_FOR_CONFIRM_SQL, [preview.codeRef, input.siteId]);
    const code = codes[0];
    if (code === undefined || codes.length !== 1) return rejected();
    locks.enter("billing_account");
    const accounts = await sql.query<Record<string, unknown> & {
      accountState: "active" | "suspended" | "closed";
      membershipState: "active" | "revoked";
      subjectGeneration: bigint | string;
      redemptionCount: bigint | string;
    }>(BILLING_FOR_CONFIRM_SQL, [
      preview.billingAccountId,
      input.siteId,
      input.subjectId,
      preview.redemptionProgramRevisionRef,
    ]);
    const account = accounts[0];
    if (account === undefined || accounts.length !== 1) return rejected();
    const storedOutputs = await sql.query<OutputRow>(OUTPUT_FOR_CONFIRM_SQL, [
      preview.fulfillmentProgramRevisionRef,
      input.siteId,
    ]);
    const outputs = await resolveCreditOutputs(this.#creditPrograms, transaction, input.siteId, storedOutputs);
    if (!outputsMatchPreview(outputs, preview, safeTerms)) return rejected();
    let subscription: PreparedFulfillmentSubscription | null = null;
    if (safeTerms.term.action !== "none") {
      if (program.stackingScope === null || program.termAction !== safeTerms.term.action || program.termSeconds === null) {
        return rejected();
      }
      locks.enter("subscription");
      const subscriptions = await sql.query<Record<string, unknown> & {
        subscriptionId: string;
        state: "active" | "expired" | "revoked";
        planRef: string;
      }>(SUBSCRIPTION_FOR_CONFIRM_SQL, [input.siteId, preview.billingAccountId, program.stackingScope]);
      if (subscriptions.length > 1) throw new Error("SUBSCRIPTION_AUTHORITY_AMBIGUOUS");
      const storedSubscription = subscriptions[0];
      if (storedSubscription !== undefined && storedSubscription.planRef !== safeTerms.planRef) return rejected();
      subscription = Object.freeze({
        subscriptionId: storedSubscription?.subscriptionId ?? null,
        state: storedSubscription?.state ?? null,
        planRef: storedSubscription?.planRef ?? null,
        activeTermEndsAt: null,
      });
      locks.enter("term_allocation");
    }
    const effectRows = await sql.query<Record<string, unknown> & { effectAt: Date | string }>(
      `SELECT clock_timestamp() AS "effectAt"`,
    );
    const effectAt = effectRows.length === 1 && effectRows[0] !== undefined ? instant(effectRows[0].effectAt) : null;
    if (effectAt === null) return rejected();
    let creditGrantPreparation: PreparedCreditGrantIssuance | null = null;
    if (outputs.some((output) => output.outputKind === "credit_grant")) {
      locks.enter("credit_account");
      const source = createFulfillmentSourceIdentity({ siteId: input.siteId, sourceType: "redemption",
        sourceRef: preview.codeRef, purpose: "acquisition", cycleKey: "once" });
      const prepared = await this.#creditGrants.prepareIssuance(transaction, {
        commandId: input.commandId,
        grants: outputs.flatMap((output) => output.outputKind !== "credit_grant" ? [] :
          Array.from({ length: output.cardinality }, (_, index) => {
            if (output.creditProgramRevisionRef === null || output.bucketClass === null || output.amount === null ||
                output.creditProgramRevisionVersion === null || output.creditProgramRevisionDigest === null ||
                output.burnPriority === null || output.scopePolicy === null) throw new Error("REDEMPTION_OUTPUT_INVALID");
            const occurrence = index + 1;
            return Object.freeze({ account: fulfillmentCreditAccountIdentity(input.siteId, preview.billingAccountId, output),
              outputLineId: output.outputLineId, outputOrdinal: output.ordinal, occurrence,
              creditProgramRevisionRef: output.creditProgramRevisionRef,
              creditProgramRevision: output.creditProgramRevisionVersion,
              creditProgramRevisionDigest: output.creditProgramRevisionDigest,
              sourceType: "redemption" as const,
              sourceRef: `${source.idempotencyKey}:${output.outputLineId}:${occurrence}`,
              sourceWindowKey: "",
              businessOperationKey: `fulfillment:${source.idempotencyKey}:${output.outputLineId}:${occurrence}`,
              bucketClass: output.bucketClass, amount: output.amount, burnPriority: output.burnPriority,
              scopePolicy: output.scopePolicy, acquiredAt: effectAt, effectiveAt: effectAt,
              expiresAt: null });
          })),
      });
      if (prepared.kind === "unavailable") return rejected();
      creditGrantPreparation = prepared.preparation;
    }

    if (!matchesConfirmationEffect(preview, effectAt) ||
      !programMatches(program, preview, safeTerms, effectAt) ||
      !planMatches(catalogPlan, safeTerms) ||
      batch.state !== "active" || batch.redemptionProgramRevisionRef !== preview.redemptionProgramRevisionRef ||
      !activeAt(batch.startsAt, batch.endsAt, effectAt) ||
      code.state !== "available" || code.batchRef !== preview.batchRef ||
      code.safeCodeFingerprint !== preview.safeCodeFingerprint ||
      account.accountState !== "active" || account.membershipState !== "active" ||
      account.subjectGeneration.toString() !== input.subjectGeneration ||
      BigInt(account.redemptionCount) >= BigInt(program.maxRedemptionsPerAccount)) return rejected();

    if (subscription?.subscriptionId !== null && subscription !== null) {
      const activeTerms = await sql.query<Record<string, unknown> & { activeTermEndsAt: Date | string | null }>(
        ACTIVE_SUBSCRIPTION_TERM_SQL,
        [subscription.subscriptionId, input.siteId, effectAt],
      );
      if (activeTerms.length !== 1) throw new Error("SUBSCRIPTION_TERM_AUTHORITY_INVALID");
      subscription = Object.freeze({
        ...subscription,
        activeTermEndsAt: activeTerms[0]!.activeTermEndsAt === null ? null : instant(activeTerms[0]!.activeTermEndsAt),
      });
    }
    const subscriptionTerm = subscription === null ? null : resolveSubscriptionTerm(
      subscription, preview, safeTerms, program.termSeconds!, effectAt,
    );
    if ((subscription === null) !== (subscriptionTerm === null)) return rejected();

    const claimedCode = await sql.execute(
      `UPDATE platform.commerce_redeem_code SET state='claimed',claimed_by_command_id=$3,claimed_at=$4::timestamptz
       WHERE code_ref=$1::uuid AND site_ref=$2 AND state='available'`,
      [preview.codeRef, input.siteId, input.commandId, effectAt],
    );
    if (claimedCode !== 1) return rejected();
    const consumedPreview = await sql.execute(
      `UPDATE platform.commerce_redemption_preview SET state='consumed',consumed_by_command_id=$3,consumed_at=$4::timestamptz
       WHERE preview_ref=$1::uuid AND site_ref=$2 AND state='live' AND expires_at>$4::timestamptz`,
      [preview.previewRef, input.siteId, input.commandId, effectAt],
    );
    if (consumedPreview !== 1) throw new Error("REDEMPTION_PREVIEW_CLAIM_CONFLICT");

    let referenceOrdinal = 0;
    const nextRef = (purpose: string) => this.#reference(purpose, referenceOrdinal++, Date.parse(effectAt));
    const redemptionId = nextRef("redemption");
    const fulfillmentId = nextRef("fulfillment");
    if (creditGrantPreparation !== null) locks.enter("credit_grant");
    const inserted = await sql.execute(
      `INSERT INTO platform.commerce_redemption
       (redemption_id,command_id,site_ref,billing_account_ref,code_ref,batch_ref,
        redemption_program_revision_ref,product_version_ref,plan_version_ref,safe_code_fingerprint,state,state_observed_at)
       VALUES ($1::uuid,$2,$3,$4,$5::uuid,$6::uuid,$7,$8,$9,$10,'executing',$11::timestamptz)`,
      [redemptionId, input.commandId, input.siteId, preview.billingAccountId, preview.codeRef, preview.batchRef,
        preview.redemptionProgramRevisionRef, safeTerms.productVersionRef, safeTerms.planVersionRef,
        preview.safeCodeFingerprint, effectAt],
    );
    if (inserted !== 1) throw new Error("REDEMPTION_INSERT_FAILED");
    const outputPlan = fulfillmentPlan(outputs);
    const fulfillment = await this.#fulfillment.execute(transaction, {
      fulfillmentId,
      commandId: input.commandId,
      siteId: input.siteId,
      billingAccountId: preview.billingAccountId,
      sourceType: "redemption",
      sourceRef: preview.codeRef,
      purpose: "acquisition",
      cycleKey: "once",
      productVersionRef: safeTerms.productVersionRef,
      planVersionRef: safeTerms.planVersionRef,
      offeringVersionRef: preview.redemptionProgramRevisionRef,
      sourceVersion: 1n,
      sourceDigest: digest({
        version: 1,
        sourceType: "redemption",
        productRevisionDigest: preview.productRevisionDigest,
        programDigest: preview.programDigest,
        outputPlanDigest: preview.outputPlanDigest,
        safeTerms,
      }),
      acquiredAt: effectAt,
      fulfillmentProgramRevisionRef: preview.fulfillmentProgramRevisionRef,
      fulfillmentProgramRevision: BigInt(program.fulfillmentProgramRevision),
      fulfillmentProgramDigest: preview.outputPlanDigest,
      pricingSnapshotRef: null,
      outputPlan,
      materialization: Object.freeze({
        siteId: input.siteId,
        subjectId: input.subjectId,
        subjectGeneration: BigInt(input.subjectGeneration),
        effectAt,
        outputs,
        nextRef,
        creditGrantPreparation,
        subscription,
        subscriptionTerm,
        stackingScope: program.stackingScope,
        planRef: safeTerms.planRef,
      }),
    });
    const outputSetDigest = fulfillment.outputSetDigest;
    const fulfilled = await sql.execute(
      `UPDATE platform.commerce_redemption
       SET fulfillment_ref=$2::uuid,state='fulfilled',redeemed_at=$3::timestamptz,state_observed_at=$3::timestamptz
       WHERE redemption_id=$1::uuid AND site_ref=$4 AND state='executing'`,
      [redemptionId, fulfillment.fulfillmentId, effectAt, input.siteId],
    );
    if (fulfilled !== 1) throw new Error("REDEMPTION_COMPLETION_CONFLICT");
    for (const termRef of [...input.legalAcceptanceRefs].sort((a, b) => a.localeCompare(b, "en"))) {
      const evidenceDigest = digest({
        version: 1,
        siteId: input.siteId,
        redemptionId,
        termRef,
        commandId: input.commandId,
        workloadIdentityId: input.workloadIdentityId,
        authorityReleaseRef: input.authorityReleaseRef,
        acceptedAt: effectAt,
      });
      await sql.execute(
        `INSERT INTO platform.commerce_redemption_legal_acceptance
         (redemption_id,site_ref,term_ref,command_id,workload_identity_id,site_release_ref,accepted_at,evidence_digest)
         VALUES ($1::uuid,$2,$3,$4,$5,$6,$7::timestamptz,$8)`,
        [redemptionId, input.siteId, termRef, input.commandId, input.workloadIdentityId,
          input.authorityReleaseRef, effectAt, evidenceDigest],
      );
    }
    const eventId = nextRef("outbox");
    const eventPayload = Object.freeze({
      version: 1,
      siteId: input.siteId,
      redemptionId,
      commandId: input.commandId,
      fulfillmentId: fulfillment.fulfillmentId,
      outputSetDigest,
      redeemedAt: effectAt,
    });
    const eventDigest = digest(eventPayload);
    await this.#outbox.enqueue(transaction, {
      eventId,
      owner: "commerce",
      eventType: "commerce.redemption.fulfilled.v1",
      aggregateId: redemptionId,
      payload: eventPayload,
      payloadDigest: eventDigest,
      correlationId: input.commandId,
      causationId: input.previewRef,
    });
    await this.#commerce.linkOutboxEvent(transaction, input.commandId, eventId);
    await this.#commerce.recordAudit(transaction, {
      auditId: nextRef("audit"),
      commandId: input.commandId,
      siteId: input.siteId,
      eventType: "commerce.redemption.fulfilled",
      payloadDigest: outputSetDigest,
    });
    return Object.freeze({
      kind: "succeeded" as const,
      receipt: Object.freeze({
        commandId: input.commandId,
        commandReceivedAt: effectAt,
        commandUpdatedAt: effectAt,
        redemptionId,
        fulfillmentRef: fulfillment.fulfillmentId,
        outputSetDigest,
        outputs: fulfillment.outputs,
        planRef: safeTerms.planRef,
        planVersionRef: safeTerms.planVersionRef,
        productRef: safeTerms.productRef,
        productVersionRef: safeTerms.productVersionRef,
        redeemedAt: effectAt,
        safeCodeFingerprint: preview.safeCodeFingerprint,
        state: "fulfilled" as const,
        stateObservedAt: effectAt,
        reversalRefs: Object.freeze([]),
      }),
    });
  }

  async findConfirmationByCommand(
    transaction: Parameters<RedemptionConfirmationRepository["findConfirmationByCommand"]>[0],
    input: Parameters<RedemptionConfirmationRepository["findConfirmationByCommand"]>[1],
  ): Promise<StoredRedemptionConfirmation | null> {
    const sql = resolvePlatformTransaction(transaction);
    const commands = await sql.query<ConfirmationCommandRow>(CONFIRMATION_COMMAND_SQL, [
      input.commandId, input.siteId, input.subjectId, input.subjectGeneration,
    ]);
    const command = commands[0];
    if (command === undefined || commands.length !== 1) return null;
    return loadConfirmation(transaction, this.#creditCorrections, command, input.siteId);
  }

  async findConfirmationByIdempotencyKey(
    transaction: Parameters<RedemptionConfirmationRepository["findConfirmationByIdempotencyKey"]>[0],
    input: Parameters<RedemptionConfirmationRepository["findConfirmationByIdempotencyKey"]>[1],
  ): ReturnType<RedemptionConfirmationRepository["findConfirmationByIdempotencyKey"]> {
    const sql = resolvePlatformTransaction(transaction);
    const commands = await sql.query<ConfirmationCommandRow>(CONFIRMATION_BY_IDEMPOTENCY_SQL, [
      input.siteId, input.subjectId, input.subjectGeneration, input.idempotencyKey,
    ]);
    const command = commands[0];
    if (command === undefined || commands.length !== 1) return null;
    const confirmation = await loadConfirmation(transaction, this.#creditCorrections, command, input.siteId);
    return confirmation === null ? null : Object.freeze({
      commandId: command.commandId,
      requestDigest: command.requestDigest,
      confirmation,
    });
  }

  async findRedemptionReceipt(
    transaction: Parameters<RedemptionConfirmationRepository["findRedemptionReceipt"]>[0],
    input: Parameters<RedemptionConfirmationRepository["findRedemptionReceipt"]>[1],
  ): ReturnType<RedemptionConfirmationRepository["findRedemptionReceipt"]> {
    return loadReceipt(transaction, this.#creditCorrections, REDEMPTION_RECEIPT_BY_ID_SQL, [
      input.redemptionId, input.siteId, input.subjectId, input.subjectGeneration,
    ], input.siteId);
  }

}

async function loadConfirmation(
  transaction: Parameters<RedemptionConfirmationRepository["findConfirmationByCommand"]>[0],
  creditCorrections: CreditSourceCorrectionPort,
  command: ConfirmationCommandRow,
  siteId: string,
): Promise<StoredRedemptionConfirmation | null> {
  const commandReceivedAt = instant(command.commandReceivedAt);
  const commandUpdatedAt = instant(command.commandUpdatedAt);
  if (command.state === "failed") return Object.freeze({
    state: "failed" as const,
    commandReceivedAt,
    commandUpdatedAt,
    code: "REDEEM_NOT_ACCEPTED" as const,
  });
  if (command.state === "pending" || command.state === "outcome_unknown") return Object.freeze({
    state: command.state,
    commandReceivedAt,
    commandUpdatedAt,
  });
  const receipt = await loadReceipt(transaction, creditCorrections, REDEMPTION_RECEIPT_SQL,
    [command.commandId, siteId], siteId);
  return receipt === null ? null : Object.freeze({
    state: "succeeded" as const,
    receipt: Object.freeze({ ...receipt, commandReceivedAt, commandUpdatedAt }),
  });
}

async function loadReceipt(
  transaction: Parameters<RedemptionConfirmationRepository["findRedemptionReceipt"]>[0],
  creditCorrections: CreditSourceCorrectionPort,
  statement: string,
  values: readonly unknown[],
  siteId: string,
): Promise<RedemptionReceiptRecord | null> {
  const sql = resolvePlatformTransaction(transaction);
  const redemptions = await sql.query<RedemptionReceiptRow>(statement, values);
  const redemption = redemptions[0];
  if (redemption === undefined || redemptions.length !== 1) return null;
  const storedOutputs = await sql.query<Record<string, unknown> & RedemptionOutputReceipt>(
    REDEMPTION_OUTPUT_RECEIPT_SQL,
    [redemption.fulfillmentRef],
  );
  const outputs = Object.freeze(storedOutputs.map((output) => {
    const commitment = Object.freeze({ kind: output.kind, outputLineId: output.outputLineId,
      outputOrdinal: Number(output.outputOrdinal), occurrence: Number(output.occurrence),
      resourceRef: output.resourceRef, templateRevisionRef: output.templateRevisionRef,
      outputVersion: Number(output.outputVersion) as 1, outputDigest: output.outputDigest });
    if (!Number.isInteger(commitment.outputOrdinal) || commitment.outputOrdinal < 1 ||
        !Number.isInteger(commitment.occurrence) || commitment.occurrence < 1 || commitment.outputVersion !== 1 ||
        digest({ version: 1, kind: commitment.kind, outputLineId: commitment.outputLineId,
          outputOrdinal: commitment.outputOrdinal, occurrence: commitment.occurrence,
          resourceRef: commitment.resourceRef, templateRevisionRef: commitment.templateRevisionRef,
          outputVersion: commitment.outputVersion }) !== commitment.outputDigest) {
      throw new Error("REDEMPTION_OUTPUT_COMMITMENT_INVALID");
    }
    return commitment;
  }));
  if (digest({ version: 1, outputs }) !== redemption.outputSetDigest) {
    throw new Error("REDEMPTION_OUTPUT_SET_DIGEST_MISMATCH");
  }
  const commerceCorrections = await sql.query<Record<string, unknown> & { reversalRef: string }>(
    REDEMPTION_REVERSAL_RECEIPT_SQL,
    [redemption.fulfillmentIdempotencyKey, siteId],
  );
  const creditCorrectionsRefs = await creditCorrections.listCorrectionRefs(transaction, {
    siteId, sourceType: "redemption", sourceRefPrefix: redemption.fulfillmentIdempotencyKey,
  });
  const reversals = [...new Set([...commerceCorrections.map((row) => row.reversalRef), ...creditCorrectionsRefs])]
    .sort((left, right) => left.localeCompare(right, "en"));
  return Object.freeze({
    commandId: redemption.commandId,
    redemptionId: redemption.redemptionId,
    fulfillmentRef: redemption.fulfillmentRef,
    outputSetDigest: redemption.outputSetDigest,
    outputs,
    planRef: redemption.planRef,
    planVersionRef: redemption.planVersionRef,
    productRef: redemption.productRef,
    productVersionRef: redemption.productVersionRef,
    redeemedAt: instant(redemption.redeemedAt),
    safeCodeFingerprint: redemption.safeCodeFingerprint,
    state: redemption.state,
    stateObservedAt: instant(redemption.stateObservedAt),
    reversalRefs: Object.freeze(reversals),
  });
}

function matchesConfirmationBinding(
  preview: PreviewConfirmationRow,
  safeTerms: RedemptionSafeTerms,
  input: Parameters<RedemptionConfirmationRepository["confirmRedemption"]>[1],
): boolean {
  return preview.state === "live" &&
    preview.previewRef === input.previewRef && preview.siteId === input.siteId &&
    preview.subjectId === input.subjectId && preview.subjectGeneration.toString() === input.subjectGeneration &&
    preview.credentialKeyRevision === input.credentialKeyRevision && preview.credentialDigest === input.credentialDigest &&
    sameSet(safeTerms.legalTermRefs, input.legalAcceptanceRefs) &&
    preview.previewDigest === redemptionPreviewDigest({
      siteId: preview.siteId,
      subjectId: preview.subjectId,
      subjectGeneration: preview.subjectGeneration.toString(),
      billingAccountId: preview.billingAccountId,
      candidate: {
        codeRef: preview.codeRef,
        batchRef: preview.batchRef,
        redemptionProgramRevisionRef: preview.redemptionProgramRevisionRef,
        fulfillmentProgramRevisionRef: preview.fulfillmentProgramRevisionRef,
        productRevisionDigest: preview.productRevisionDigest,
        programDigest: preview.programDigest,
        outputPlanDigest: preview.outputPlanDigest,
        safeCodeFingerprint: preview.safeCodeFingerprint,
        safeTerms,
      },
      expiresAt: instant(preview.expiresAt),
    });
}

function matchesConfirmationEffect(preview: PreviewConfirmationRow, effectAt: string): boolean {
  return preview.state === "live" && Date.parse(instant(preview.expiresAt)) > Date.parse(effectAt);
}

function planMatches(
  plan: Readonly<{ planRef: string; state: "active" | "disabled" }> | null,
  safeTerms: RedemptionSafeTerms,
): boolean {
  if (safeTerms.planRef === null || safeTerms.planVersionRef === null) {
    return safeTerms.planRef === null && safeTerms.planVersionRef === null && plan === null;
  }
  return plan !== null && plan.planRef === safeTerms.planRef && plan.state === "active";
}

function programMatches(
  program: ProgramConfirmationRow,
  preview: PreviewConfirmationRow,
  safeTerms: RedemptionSafeTerms,
  now: string,
): boolean {
  return program.availabilityState === "active" && program.productState === "active" &&
    activeAt(program.startsAt, program.endsAt, now) &&
    program.redemptionProgramRevisionRef === preview.redemptionProgramRevisionRef &&
    program.programDigest === preview.programDigest &&
    program.productRef === safeTerms.productRef && program.productVersionRef === safeTerms.productVersionRef &&
    program.planRef === safeTerms.planRef && program.planVersionRef === safeTerms.planVersionRef &&
    program.productRevisionDigest === preview.productRevisionDigest &&
    program.fulfillmentProgramRevisionRef === preview.fulfillmentProgramRevisionRef &&
    program.outputPlanDigest === preview.outputPlanDigest &&
    Number.isInteger(program.maxRedemptionsPerAccount) && program.maxRedemptionsPerAccount > 0;
}

function outputsMatchPreview(
  outputs: readonly OutputRow[],
  preview: PreviewConfirmationRow,
  safeTerms: RedemptionSafeTerms,
): boolean {
  if (outputs.length < 1 || outputs.length > 256 ||
    publishedFulfillmentOutputPlanDigest({
      siteId: preview.siteId,
      fulfillmentProgramRevisionRef: preview.fulfillmentProgramRevisionRef,
      lines: outputs,
    }) !== preview.outputPlanDigest) return false;
  const expectedCredits = safeTerms.credits.map((item) => commerceCanonicalJson(item)).sort();
  const expectedEntitlements = safeTerms.entitlements.map((item) => commerceCanonicalJson(item)).sort();
  const actualCredits: string[] = [];
  const actualEntitlements: string[] = [];
  let subscriptionTerms = 0;
  for (const [index, output] of outputs.entries()) {
    if (output.ordinal !== index + 1 || !Number.isInteger(output.cardinality) || output.cardinality < 1 || output.cardinality > 32) {
      return false;
    }
    for (let occurrence = 0; occurrence < output.cardinality; occurrence += 1) {
      if (output.outputKind === "entitlement_grant") {
        if (output.entitlementTemplateRevisionRef === null || output.capabilityKey === null || output.safeLabel === null) return false;
        actualEntitlements.push(commerceCanonicalJson({
          entitlementTemplateRevisionRef: output.entitlementTemplateRevisionRef,
          capabilityKey: output.capabilityKey,
          safeLabel: output.safeLabel,
          expiresAt: expiry(instant(preview.createdAt), output.entitlementExpiresAfterSeconds),
        }));
      } else if (output.outputKind === "credit_grant" || output.outputKind === "credit_program_enrollment") {
        if (output.creditProgramRevisionRef === null || output.bucketClass === null || output.unit === null || output.amount === null) {
          return false;
        }
        actualCredits.push(commerceCanonicalJson({
          creditProgramRevisionRef: output.creditProgramRevisionRef,
          bucketClass: output.bucketClass,
          unit: output.unit,
          amount: output.amount,
          expiresAt: output.outputKind === "credit_program_enrollment" ? safeTerms.term.endsAt : null,
        }));
      } else {
        if (output.cardinality !== 1 || output.planVersionRef !== safeTerms.planVersionRef) return false;
        subscriptionTerms += 1;
      }
    }
  }
  return sameStrings(expectedCredits, actualCredits.sort()) &&
    sameStrings(expectedEntitlements, actualEntitlements.sort()) &&
    (safeTerms.term.action === "none" ? subscriptionTerms === 0 : subscriptionTerms === 1);
}

async function resolveCreditOutputs(port: CreditGrantProgramPort,
  transaction: Parameters<RedemptionConfirmationRepository["confirmRedemption"]>[0], siteId: string,
  outputs: readonly OutputRow[]): Promise<readonly OutputRow[]> {
  const targets = new Map<string, { revisionRef: string; revision: bigint; revisionDigest: string }>();
  for (const output of outputs) {
    if (output.outputKind !== "credit_grant" && output.outputKind !== "credit_program_enrollment") continue;
    if (output.creditProgramRevisionRef === null || output.creditProgramRevisionVersion === null ||
        output.creditProgramRevisionDigest === null) throw new Error("REDEMPTION_OUTPUT_INVALID");
    const target = { revisionRef: output.creditProgramRevisionRef, revision: BigInt(output.creditProgramRevisionVersion),
      revisionDigest: output.creditProgramRevisionDigest };
    const prior = targets.get(target.revisionRef);
    if (prior !== undefined && (prior.revision !== target.revision || prior.revisionDigest !== target.revisionDigest)) {
      throw new Error("REDEMPTION_OUTPUT_INVALID");
    }
    targets.set(target.revisionRef, target);
  }
  if (targets.size === 0) return outputs;
  const programs = await port.resolveTargets(transaction, { siteId, targets: [...targets.values()] });
  const byRef = new Map(programs.map((program) => [program.revisionRef, program]));
  return Object.freeze(outputs.map((output) => {
    if (output.outputKind !== "credit_grant" && output.outputKind !== "credit_program_enrollment") return output;
    const program = byRef.get(output.creditProgramRevisionRef!);
    if (program === undefined) throw new Error("REDEMPTION_OUTPUT_INVALID");
    return Object.freeze({ ...output, bucketClass: program.bucketClass, unit: program.unit, amount: program.amount,
      creditExpiresAfterSeconds: program.expiresAfterSeconds,
      creditWindowKind: program.windowKind, creditCalendarZone: program.calendarZone,
      creditWindowAnchor: program.windowAnchor,
      liabilityMerchantAccountId: program.liabilityMerchantAccountId, burnPriority: program.burnPriority,
      scopePolicy: program.scopePolicy });
  }));
}

function resolveSubscriptionTerm(
  subscription: PreparedFulfillmentSubscription,
  preview: PreviewConfirmationRow,
  safeTerms: RedemptionSafeTerms,
  termSeconds: bigint | string,
  effectAt: string,
): PostgresFulfillmentMaterialization["subscriptionTerm"] {
  if (subscription.state === "revoked" || safeTerms.term.startsAt === null || safeTerms.term.endsAt === null ||
    safeTerms.planRef === null || (subscription.subscriptionId !== null && subscription.planRef !== safeTerms.planRef)) {
    return null;
  }
  const startsAt = Date.parse(safeTerms.term.startsAt);
  const endsAt = Date.parse(safeTerms.term.endsAt);
  const duration = BigInt(termSeconds) * 1000n;
  if (duration <= 0n || BigInt(endsAt) - BigInt(startsAt) !== duration) return null;
  const activeTermEndsAt = subscription.activeTermEndsAt;
  let materializedStartsAt: string;
  if (activeTermEndsAt !== null && Date.parse(activeTermEndsAt) > Date.parse(effectAt)) {
    if (subscription.state !== "active" || safeTerms.term.action !== "extend_from_max" ||
      safeTerms.term.startsAt !== activeTermEndsAt) return null;
    materializedStartsAt = activeTermEndsAt;
  } else {
    if (safeTerms.term.startsAt !== instant(preview.createdAt)) return null;
    materializedStartsAt = effectAt;
  }
  return Object.freeze({
    startsAt: materializedStartsAt,
    endsAt: expiry(materializedStartsAt, BigInt(termSeconds))!,
  });
}

function fulfillmentPlan(outputs: readonly OutputRow[]): readonly FulfillmentOutputLine[] {
  return Object.freeze(outputs.map((output) => Object.freeze({
    outputLineId: output.outputLineId,
    ordinal: output.ordinal,
    cardinality: output.cardinality,
    templateRevision: output.outputKind === "subscription_term" ? output.planVersionRef! :
      output.outputKind === "entitlement_grant" ? output.entitlementTemplateRevisionRef! : output.creditProgramRevisionRef!,
    outputKind: output.outputKind,
    disposition: "required" as const,
  })));
}

function activeAt(startsAt: Date | string | null, endsAt: Date | string | null, now: string): boolean {
  const timestamp = Date.parse(now);
  return (startsAt === null || Date.parse(instant(startsAt)) <= timestamp) &&
    (endsAt === null || Date.parse(instant(endsAt)) > timestamp);
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length && new Set(right).size === right.length &&
    [...left].sort((a, b) => a.localeCompare(b, "en")).every((value, index) =>
      value === [...right].sort((a, b) => a.localeCompare(b, "en"))[index]);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function expiry(start: string, seconds: bigint | null): string | null {
  if (seconds === null) return null;
  const value = BigInt(Date.parse(start)) + seconds * 1000n;
  if (value > 8_640_000_000_000_000n) throw new Error("REDEMPTION_EXPIRY_INVALID");
  return new Date(Number(value)).toISOString();
}

function digest(value: Parameters<typeof commerceCanonicalJson>[0]): string {
  return createHash("sha256").update(commerceCanonicalJson(value), "utf8").digest("hex");
}

function instant(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("REDEMPTION_TIMESTAMP_INVALID");
  return parsed.toISOString();
}

function rejected() {
  return Object.freeze({ kind: "rejected" as const, code: "REDEEM_NOT_ACCEPTED" as const });
}

const PREVIEW_FOR_CONFIRM_SQL = `
  SELECT preview.preview_ref AS "previewRef",preview.site_ref AS "siteId",
         preview.subject_ref AS "subjectId",preview.subject_generation AS "subjectGeneration",
         preview.billing_account_ref AS "billingAccountId",preview.code_ref AS "codeRef",
         preview.batch_ref AS "batchRef",preview.redemption_program_revision_ref AS "redemptionProgramRevisionRef",
         preview.fulfillment_program_revision_ref AS "fulfillmentProgramRevisionRef",
         preview.product_revision_digest AS "productRevisionDigest",preview.program_digest AS "programDigest",
         preview.output_plan_digest AS "outputPlanDigest",preview.preview_digest AS "previewDigest",
         preview.credential_key_revision AS "credentialKeyRevision",preview.credential_digest AS "credentialDigest",
         preview.safe_terms AS "safeTerms",preview.state,preview.expires_at AS "expiresAt",
         preview.created_at AS "createdAt",code.safe_fingerprint AS "safeCodeFingerprint"
  FROM platform.commerce_redemption_preview preview
  JOIN platform.commerce_redeem_code code ON code.code_ref=preview.code_ref AND code.site_ref=preview.site_ref
  WHERE preview.preview_ref=$1::uuid AND preview.site_ref=$2
  FOR UPDATE OF preview`;

const PROGRAM_FOR_CONFIRM_SQL = `
  SELECT availability.state AS "availabilityState",availability.starts_at AS "startsAt",
         availability.ends_at AS "endsAt",program.redemption_program_revision_ref AS "redemptionProgramRevisionRef",
         program.program_digest AS "programDigest",program.max_redemptions_per_account AS "maxRedemptionsPerAccount",
         product.state AS "productState",product.product_ref AS "productRef",
         product_version.product_version_ref AS "productVersionRef",plan_version.plan_ref AS "planRef",
         plan_version.plan_version_ref AS "planVersionRef",product_version.revision_digest AS "productRevisionDigest",
         program.fulfillment_program_revision_ref AS "fulfillmentProgramRevisionRef",
         fulfillment.revision AS "fulfillmentProgramRevision",
         fulfillment.output_plan_digest AS "outputPlanDigest",plan_version.stacking_scope AS "stackingScope"
         ,plan_version.term_action AS "termAction",plan_version.term_seconds AS "termSeconds"
  FROM platform.commerce_redemption_program_availability availability
  JOIN platform.commerce_redemption_program_revision program
    ON program.redemption_program_revision_ref=availability.redemption_program_revision_ref
      AND program.site_ref=availability.site_ref
  JOIN platform.commerce_catalog_product_version product_version
    ON product_version.product_version_ref=program.product_version_ref AND product_version.site_ref=program.site_ref
  JOIN platform.commerce_catalog_product product
    ON product.site_ref=product_version.site_ref AND product.product_ref=product_version.product_ref
  JOIN platform.commerce_fulfillment_program_revision fulfillment
    ON fulfillment.fulfillment_program_revision_ref=program.fulfillment_program_revision_ref
      AND fulfillment.site_ref=program.site_ref
  LEFT JOIN platform.commerce_catalog_plan_version plan_version
    ON plan_version.plan_version_ref=product_version.plan_version_ref AND plan_version.site_ref=product_version.site_ref
  WHERE availability.redemption_program_revision_ref=$1 AND availability.site_ref=$2
  FOR UPDATE OF availability,product`;

const PLAN_FOR_CONFIRM_SQL = `
  SELECT plan_ref AS "planRef",state
  FROM platform.commerce_catalog_plan
  WHERE site_ref=$1 AND plan_ref=$2
  FOR UPDATE`;

const BATCH_FOR_CONFIRM_SQL = `
  SELECT state,starts_at AS "startsAt",ends_at AS "endsAt",
         redemption_program_revision_ref AS "redemptionProgramRevisionRef"
  FROM platform.commerce_code_batch
  WHERE batch_ref=$1::uuid AND site_ref=$2
  FOR UPDATE`;

const CODE_FOR_CONFIRM_SQL = `
  SELECT state,batch_ref AS "batchRef",safe_fingerprint AS "safeCodeFingerprint"
  FROM platform.commerce_redeem_code
  WHERE code_ref=$1::uuid AND site_ref=$2
  FOR UPDATE`;

const BILLING_FOR_CONFIRM_SQL = `
  SELECT account.state AS "accountState",membership.state AS "membershipState",
         membership.subject_generation AS "subjectGeneration",
         (SELECT count(*) FROM platform.commerce_redemption redemption
          WHERE redemption.site_ref=account.site_ref
            AND redemption.billing_account_ref=account.billing_account_ref
            AND redemption.redemption_program_revision_ref=$4
            AND redemption.state IN ('fulfilled','reversed','reconciliation_required')) AS "redemptionCount"
  FROM platform.commerce_billing_account account
  JOIN platform.commerce_billing_account_membership membership
    ON membership.billing_account_ref=account.billing_account_ref AND membership.site_ref=account.site_ref
  WHERE account.billing_account_ref=$1 AND account.site_ref=$2 AND membership.subject_ref=$3
  FOR UPDATE OF account,membership`;

const SUBSCRIPTION_FOR_CONFIRM_SQL = `
  SELECT subscription.subscription_ref AS "subscriptionId",subscription.state,
         subscription.plan_ref AS "planRef"
  FROM platform.commerce_subscription subscription
  WHERE subscription.site_ref=$1 AND subscription.billing_account_ref=$2 AND subscription.stacking_scope=$3
  FOR UPDATE OF subscription`;

const ACTIVE_SUBSCRIPTION_TERM_SQL = `
  SELECT max(term.ends_at) AS "activeTermEndsAt"
  FROM platform.commerce_subscription_term term
  WHERE term.subscription_ref=$1::uuid AND term.site_ref=$2 AND term.ends_at>$3::timestamptz
    AND NOT EXISTS (
      SELECT 1 FROM platform.commerce_subscription_term_revocation revocation
      WHERE revocation.subscription_term_ref=term.subscription_term_ref
        AND revocation.site_ref=term.site_ref AND revocation.effective_at<=$3::timestamptz
    )`;

const OUTPUT_FOR_CONFIRM_SQL = `
  SELECT output.output_line_id AS "outputLineId",output.output_kind AS "outputKind",
         output.ordinal,output.cardinality,output.plan_version_ref AS "planVersionRef",
         output.credit_program_revision_ref AS "creditProgramRevisionRef",
         output.credit_program_revision_version AS "creditProgramRevisionVersion",
         output.credit_program_revision_digest AS "creditProgramRevisionDigest",
         COALESCE(plan.revision,entitlement.revision,output.credit_program_revision_version) AS "ownerRevision",
         COALESCE(plan.revision_digest,entitlement.revision_digest,output.credit_program_revision_digest) AS "ownerRevisionDigest",
         NULL::text AS "bucketClass",NULL::text AS unit,NULL::text AS amount,
         NULL::bigint AS "creditExpiresAfterSeconds",NULL::text AS "liabilityMerchantAccountId",
         NULL::text AS "creditWindowKind",NULL::text AS "creditCalendarZone",NULL::text AS "creditWindowAnchor",
         NULL::integer AS "burnPriority",NULL::jsonb AS "scopePolicy",
         output.entitlement_template_revision_ref AS "entitlementTemplateRevisionRef",
         entitlement.capability_key AS "capabilityKey",entitlement.safe_label AS "safeLabel",
         entitlement.expires_after_seconds AS "entitlementExpiresAfterSeconds"
  FROM platform.commerce_fulfillment_program_output output
  LEFT JOIN platform.commerce_entitlement_template_revision entitlement
    ON entitlement.entitlement_template_revision_ref=output.entitlement_template_revision_ref AND entitlement.site_ref=$2
  LEFT JOIN platform.commerce_catalog_plan_version plan
    ON plan.plan_version_ref=output.plan_version_ref AND plan.site_ref=$2
  WHERE output.fulfillment_program_revision_ref=$1 AND output.site_ref=$2
    AND (output.output_kind<>'entitlement_grant' OR entitlement.entitlement_template_revision_ref IS NOT NULL)
    AND (output.output_kind<>'subscription_term' OR plan.plan_version_ref IS NOT NULL)
  ORDER BY output.ordinal`;

const CONFIRMATION_COMMAND_SQL = `
  SELECT receipt.command_id AS "commandId",receipt.request_digest AS "requestDigest",receipt.state,
         receipt.created_at AS "commandReceivedAt",receipt.updated_at AS "commandUpdatedAt"
  FROM platform.command_receipt receipt
  JOIN platform.commerce_command command ON command.command_id=receipt.command_id
  WHERE receipt.command_id=$1 AND command.site_ref=$2 AND command.actor_kind='user'
    AND command.actor_subject=$3 AND command.actor_generation=$4::bigint
    AND receipt.operation='confirmRedemption'`;

const CONFIRMATION_BY_IDEMPOTENCY_SQL = `
  SELECT receipt.command_id AS "commandId",receipt.request_digest AS "requestDigest",receipt.state,
         receipt.created_at AS "commandReceivedAt",receipt.updated_at AS "commandUpdatedAt"
  FROM platform.commerce_command command
  JOIN platform.command_receipt receipt ON receipt.command_id=command.command_id
  WHERE command.site_ref=$1 AND command.actor_kind='user' AND command.actor_subject=$2
    AND command.actor_generation=$3::bigint AND receipt.idempotency_key=$4
    AND receipt.operation='confirmRedemption'`;

const REDEMPTION_RECEIPT_SQL = `
  SELECT redemption.command_id AS "commandId",redemption.redemption_id AS "redemptionId",
         redemption.fulfillment_ref AS "fulfillmentRef",fulfillment.output_set_digest AS "outputSetDigest",
         fulfillment.idempotency_key AS "fulfillmentIdempotencyKey",
         product_version.plan_version_ref AS "planVersionRef",plan_version.plan_ref AS "planRef",
         product_version.product_ref AS "productRef",product_version.product_version_ref AS "productVersionRef",
         redemption.redeemed_at AS "redeemedAt",redemption.safe_code_fingerprint AS "safeCodeFingerprint",
         redemption.state,redemption.state_observed_at AS "stateObservedAt"
  FROM platform.commerce_redemption redemption
  JOIN platform.commerce_fulfillment_transaction fulfillment
    ON fulfillment.fulfillment_id=redemption.fulfillment_ref AND fulfillment.site_ref=redemption.site_ref
  JOIN platform.commerce_catalog_product_version product_version
    ON product_version.product_version_ref=redemption.product_version_ref AND product_version.site_ref=redemption.site_ref
  LEFT JOIN platform.commerce_catalog_plan_version plan_version
    ON plan_version.plan_version_ref=redemption.plan_version_ref AND plan_version.site_ref=redemption.site_ref
  WHERE redemption.command_id=$1 AND redemption.site_ref=$2
    AND redemption.state IN ('fulfilled','reversed','reconciliation_required')
    AND fulfillment.state='committed'`;

const REDEMPTION_RECEIPT_BY_ID_SQL = `
  SELECT redemption.command_id AS "commandId",redemption.redemption_id AS "redemptionId",
         redemption.fulfillment_ref AS "fulfillmentRef",fulfillment.output_set_digest AS "outputSetDigest",
         fulfillment.idempotency_key AS "fulfillmentIdempotencyKey",
         product_version.plan_version_ref AS "planVersionRef",plan_version.plan_ref AS "planRef",
         product_version.product_ref AS "productRef",product_version.product_version_ref AS "productVersionRef",
         redemption.redeemed_at AS "redeemedAt",redemption.safe_code_fingerprint AS "safeCodeFingerprint",
         redemption.state,redemption.state_observed_at AS "stateObservedAt"
  FROM platform.commerce_redemption redemption
  JOIN platform.commerce_command command
    ON command.command_id=redemption.command_id AND command.site_ref=redemption.site_ref
  JOIN platform.commerce_fulfillment_transaction fulfillment
    ON fulfillment.fulfillment_id=redemption.fulfillment_ref AND fulfillment.site_ref=redemption.site_ref
  JOIN platform.commerce_catalog_product_version product_version
    ON product_version.product_version_ref=redemption.product_version_ref AND product_version.site_ref=redemption.site_ref
  LEFT JOIN platform.commerce_catalog_plan_version plan_version
    ON plan_version.plan_version_ref=redemption.plan_version_ref AND plan_version.site_ref=redemption.site_ref
  WHERE redemption.redemption_id=$1::uuid AND redemption.site_ref=$2
    AND command.actor_kind='user' AND command.actor_subject=$3 AND command.actor_generation=$4::bigint
    AND redemption.state IN ('fulfilled','reversed','reconciliation_required')
    AND fulfillment.state='committed'`;

const REDEMPTION_OUTPUT_RECEIPT_SQL = `
  SELECT actual.output_kind AS kind,actual.output_line_id AS "outputLineId",
         actual.output_ordinal AS "outputOrdinal",actual.occurrence,
         actual.output_ref AS "resourceRef",actual.template_revision AS "templateRevisionRef",
         actual.output_version AS "outputVersion",actual.output_digest AS "outputDigest"
  FROM platform.commerce_fulfillment_actual_output actual
  JOIN platform.commerce_fulfillment_output_plan expected
    ON expected.fulfillment_id=actual.fulfillment_id AND expected.output_line_id=actual.output_line_id
  WHERE actual.fulfillment_id=$1::uuid
  ORDER BY expected.ordinal,actual.occurrence`;

const REDEMPTION_REVERSAL_RECEIPT_SQL = `
  SELECT reversal_ref AS "reversalRef" FROM (
    SELECT revocation.term_revocation_ref::text AS reversal_ref
    FROM platform.commerce_subscription_term term
    JOIN platform.commerce_subscription_term_revocation revocation
      ON revocation.subscription_term_ref=term.subscription_term_ref AND revocation.site_ref=term.site_ref
    WHERE term.site_ref=$2 AND term.source_type='redemption'
      AND strpos(term.source_ref,$1 || ':')=1
    UNION ALL
    SELECT revocation.entitlement_revocation_ref::text AS reversal_ref
    FROM platform.commerce_entitlement_grant entitlement
    JOIN platform.commerce_entitlement_revocation revocation
      ON revocation.entitlement_grant_ref=entitlement.entitlement_grant_ref AND revocation.site_ref=entitlement.site_ref
    WHERE entitlement.site_ref=$2 AND entitlement.source_type='redemption'
      AND strpos(entitlement.source_ref,$1 || ':')=1
  ) reversal
  ORDER BY reversal_ref`;
