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
import {
  publishedFulfillmentOutputPlanDigest,
  isSupportedRedemptionSafeTerms,
  redemptionPreviewDigest,
  redemptionSafeTermsSchema,
  type RedemptionSafeTerms,
  uuidV7,
} from "../../domain/redemption-preview.js";
import { commerceCanonicalJson } from "../../domain/canonical-json.js";
import type { ActualFulfillmentOutput, FulfillmentOutputLine } from "../../domain/output-line.js";
import type { CommerceLockSequence } from "../../../../workflows/commerce/lock-order.js";
import {
  creditAccountAdvisoryKey,
  lockCreditAccountAuthority,
  type CreditAccountAuthorityIdentity,
  type LockedCreditAccount,
} from "../../../credit/infrastructure/postgres/credit-account-lock.js";

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
  outputPlanDigest: string;
  stackingScope: string | null;
  termAction: RedemptionSafeTerms["term"]["action"] | null;
  termSeconds: bigint | string | null;
};

type OutputRow = Record<string, unknown> & {
  outputLineId: string;
  outputKind: "subscription_term" | "entitlement_grant" | "credit_grant";
  ordinal: number;
  cardinality: number;
  planVersionRef: string | null;
  creditProgramRevisionRef: string | null;
  bucketClass: "daily" | "period" | "permanent" | null;
  unit: string | null;
  amount: string | null;
  creditExpiresAfterSeconds: bigint | null;
  liabilityMerchantAccountId: string | null;
  burnPriority: number | null;
  scopePolicy: unknown;
  entitlementTemplateRevisionRef: string | null;
  capabilityKey: string | null;
  safeLabel: string | null;
  entitlementExpiresAfterSeconds: bigint | null;
};

type CommerceFulfillmentWriter = Pick<CommerceRepository,
  "startFulfillment" | "recordExpectedOutputPlan" | "recordActualOutputs" |
  "completeFulfillment" | "linkOutboxEvent" | "recordAudit">;

type Dependencies = Readonly<{
  commerce: CommerceFulfillmentWriter;
  outbox: Pick<OutboxRepository, "enqueue">;
  reference: (purpose: string, ordinal: number, now: number) => string;
}>;

type PreparedCreditAccount = Readonly<{
  identity: CreditAccountAuthorityIdentity;
  account: LockedCreditAccount | null;
}>;

type PreparedSubscription = Readonly<{
  subscriptionId: string | null;
  state: "active" | "expired" | "revoked" | null;
  planRef: string | null;
  activeTermEndsAt: string | null;
}>;

type PreparedSubscriptionTerm = Readonly<{ startsAt: string; endsAt: string }>;

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
};

export class PostgresRedemptionConfirmationRepository implements RedemptionConfirmationRepository {
  readonly #commerce: CommerceFulfillmentWriter;
  readonly #outbox: Pick<OutboxRepository, "enqueue">;
  readonly #reference: Dependencies["reference"];

  constructor(dependencies: Partial<Dependencies> = {}) {
    this.#commerce = dependencies.commerce ?? new PostgresCommerceRepository();
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
    const outputs = await sql.query<OutputRow>(OUTPUT_FOR_CONFIRM_SQL, [
      preview.fulfillmentProgramRevisionRef,
      input.siteId,
    ]);
    if (!outputsMatchPreview(outputs, preview, safeTerms)) return rejected();
    let subscription: PreparedSubscription | null = null;
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
    let creditAccounts = new Map<string, PreparedCreditAccount>();
    if (outputs.some((output) => output.outputKind === "credit_grant")) {
      locks.enter("credit_account");
      creditAccounts = await this.#lockCreditAccounts(transaction, outputs, input.siteId, preview.billingAccountId);
      if ([...creditAccounts.values()].some(({ account: creditAccount }) =>
        creditAccount !== null && creditAccount.state !== "active")) {
        return rejected();
      }
    }

    const effectRows = await sql.query<Record<string, unknown> & { effectAt: Date | string }>(
      `SELECT clock_timestamp() AS "effectAt"`,
    );
    const effectAt = effectRows.length === 1 && effectRows[0] !== undefined ? instant(effectRows[0].effectAt) : null;
    if (effectAt === null ||
      !matchesConfirmationEffect(preview, effectAt) ||
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
    let subscriptionId = subscription?.subscriptionId ?? null;
    if (subscription !== null) {
      if (program.stackingScope === null || safeTerms.planRef === null) throw new Error("SUBSCRIPTION_PLAN_INVALID");
      if (subscriptionId === null) {
        subscriptionId = nextRef("subscription");
        const created = await sql.execute(
          `INSERT INTO platform.commerce_subscription
           (subscription_ref,site_ref,billing_account_ref,stacking_scope,plan_ref,state)
           VALUES ($1::uuid,$2,$3,$4,$5,'active')`,
          [subscriptionId, input.siteId, preview.billingAccountId, program.stackingScope, safeTerms.planRef],
        );
        if (created !== 1) throw new Error("SUBSCRIPTION_CREATE_FAILED");
      } else if (subscription.state === "expired") {
        const reactivated = await sql.execute(
          `UPDATE platform.commerce_subscription SET state='active',aggregate_version=aggregate_version+1,updated_at=$3::timestamptz
           WHERE subscription_ref=$1::uuid AND site_ref=$2 AND state='expired'`,
          [subscriptionId, input.siteId, effectAt],
        );
        if (reactivated !== 1) throw new Error("SUBSCRIPTION_REACTIVATION_CONFLICT");
      }
    }
    if (creditAccounts.size > 0) {
      for (const [key, prepared] of creditAccounts) {
        if (prepared.account !== null) continue;
        const identity = prepared.identity;
        const creditAccountId = nextRef("credit_account");
        const created = await sql.execute(
          `INSERT INTO platform.credit_account
           (credit_account_ref,site_ref,billing_account_ref,unit,liability_merchant_account_ref,state)
           VALUES ($1::uuid,$2,$3,$4,$5,'active')`,
          [creditAccountId, identity.siteId, identity.billingAccountId, identity.unit,
            identity.liabilityMerchantAccountId],
        );
        if (created !== 1) throw new Error("CREDIT_ACCOUNT_CREATE_FAILED");
        creditAccounts.set(key, Object.freeze({ identity, account: Object.freeze({
          creditAccountId, state: "active" as const, aggregateVersion: 1n,
        }) }));
      }
      locks.enter("credit_grant");
    }
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
    await this.#commerce.startFulfillment(transaction, {
      fulfillmentId,
      commandId: input.commandId,
      siteId: input.siteId,
      billingAccountId: preview.billingAccountId,
      sourceType: "redemption",
      sourceId: redemptionId,
      purpose: "redeem_code",
      cycleKey: "once",
      productVersion: safeTerms.productVersionRef,
      planVersion: safeTerms.planVersionRef,
      offeringVersion: safeTerms.productVersionRef,
      fulfillmentProgramVersion: preview.fulfillmentProgramRevisionRef,
      outputPlanDigest: preview.outputPlanDigest,
    });
    await this.#commerce.recordExpectedOutputPlan(transaction, fulfillmentId, outputPlan);
    const materialized = await this.#materializeOutputs(transaction, {
      input, preview, safeTerms, outputs, redemptionId, nextRef, creditAccounts, subscriptionId,
      subscriptionTerm, effectAt,
    });
    await this.#commerce.recordActualOutputs(transaction, fulfillmentId, materialized.actual, outputPlan);
    const outputSetDigest = digest({ version: 1, outputs: materialized.receipts });
    const fulfillmentResultDigest = digest({
      version: 1,
      fulfillmentId,
      outputSetDigest,
      outputCount: materialized.receipts.length,
    });
    await this.#commerce.completeFulfillment(transaction, {
      fulfillmentId,
      outputSetDigest,
      resultDigest: fulfillmentResultDigest,
    });
    const fulfilled = await sql.execute(
      `UPDATE platform.commerce_redemption
       SET fulfillment_ref=$2::uuid,state='fulfilled',redeemed_at=$3::timestamptz,state_observed_at=$3::timestamptz
       WHERE redemption_id=$1::uuid AND site_ref=$4 AND state='executing'`,
      [redemptionId, fulfillmentId, effectAt, input.siteId],
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
      fulfillmentId,
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
        fulfillmentRef: fulfillmentId,
        outputSetDigest,
        outputs: Object.freeze(materialized.receipts),
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
    return loadConfirmation(sql, command, input.siteId);
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
    const confirmation = await loadConfirmation(sql, command, input.siteId);
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
    return loadReceipt(resolvePlatformTransaction(transaction), REDEMPTION_RECEIPT_BY_ID_SQL, [
      input.redemptionId, input.siteId, input.subjectId, input.subjectGeneration,
    ], input.siteId);
  }

  async #materializeOutputs(
    transaction: Parameters<RedemptionConfirmationRepository["confirmRedemption"]>[0],
    context: Readonly<{
      input: Parameters<RedemptionConfirmationRepository["confirmRedemption"]>[1];
      preview: PreviewConfirmationRow;
      safeTerms: RedemptionSafeTerms;
      outputs: readonly OutputRow[];
      redemptionId: string;
      nextRef: (purpose: string) => string;
      creditAccounts: ReadonlyMap<string, PreparedCreditAccount>;
      subscriptionId: string | null;
      subscriptionTerm: PreparedSubscriptionTerm | null;
      effectAt: string;
    }>,
  ): Promise<Readonly<{ receipts: RedemptionOutputReceipt[]; actual: ActualFulfillmentOutput[] }>> {
    const sql = resolvePlatformTransaction(transaction);
    const receipts: RedemptionOutputReceipt[] = [];
    const actual: ActualFulfillmentOutput[] = [];
    for (const output of context.outputs) {
      for (let occurrence = 1; occurrence <= output.cardinality; occurrence += 1) {
        if (output.outputKind === "entitlement_grant") {
          if (output.entitlementTemplateRevisionRef === null || output.capabilityKey === null || output.safeLabel === null) {
            throw new Error("REDEMPTION_OUTPUT_INVALID");
          }
          const outputRef = context.nextRef("entitlement_grant");
          const expiresAt = expiry(context.effectAt, output.entitlementExpiresAfterSeconds);
          await sql.execute(
            `INSERT INTO platform.commerce_entitlement_grant
             (entitlement_grant_ref,site_ref,billing_account_ref,entitlement_template_revision_ref,
              capability_key,safe_label,source_type,source_ref,effective_at,expires_at)
             VALUES ($1::uuid,$2,$3,$4,$5,$6,'redemption',$7,$8::timestamptz,$9::timestamptz)`,
            [outputRef, context.input.siteId, context.preview.billingAccountId,
              output.entitlementTemplateRevisionRef, output.capabilityKey, output.safeLabel,
              outputSourceRef(context.redemptionId, output.outputLineId, occurrence),
              context.effectAt, expiresAt],
          );
          receipts.push(Object.freeze({ kind: "entitlement_grant", outputLineId: output.outputLineId,
            resourceRef: outputRef, templateRevisionRef: output.entitlementTemplateRevisionRef }));
          actual.push(Object.freeze({ outputLineId: output.outputLineId, occurrence,
            templateRevision: output.entitlementTemplateRevisionRef, outputKind: "entitlement_grant", outputRef }));
        } else if (output.outputKind === "credit_grant") {
          if (output.creditProgramRevisionRef === null || output.bucketClass === null || output.unit === null ||
            output.amount === null || output.liabilityMerchantAccountId === null || output.burnPriority === null ||
            output.scopePolicy === null || typeof output.scopePolicy !== "object" || Array.isArray(output.scopePolicy)) {
            throw new Error("REDEMPTION_OUTPUT_INVALID");
          }
          const identity = creditIdentity(context.input.siteId, context.preview.billingAccountId, output);
          const creditAccount = context.creditAccounts.get(creditAccountAdvisoryKey(identity))?.account;
          if (creditAccount === undefined || creditAccount === null || creditAccount.state !== "active") {
            throw new Error("CREDIT_ACCOUNT_AUTHORITY_MISSING");
          }
          const outputRef = context.nextRef("credit_grant");
          const journalRef = context.nextRef("grant_issue_journal");
          const sourceRef = outputSourceRef(context.redemptionId, output.outputLineId, occurrence);
          const expiresAt = expiry(context.effectAt, output.creditExpiresAfterSeconds);
          const created = await sql.execute(
            `INSERT INTO platform.credit_grant
             (credit_grant_id,credit_account_ref,site_ref,billing_account_ref,credit_program_revision_ref,
              source_type,source_ref,issuance_journal_transaction_ref,ux_bucket_class,unit,
              liability_merchant_account_ref,original_amount,burn_priority,scope_policy,effective_at,expires_at,issued_at)
             VALUES ($1::uuid,$2::uuid,$3,$4,$5,'redemption',$6,$7::uuid,$8,$9,$10,$11::numeric,$12,$13::jsonb,
                     $14::timestamptz,$15::timestamptz,$14::timestamptz)`,
            [outputRef, creditAccount.creditAccountId, context.input.siteId, context.preview.billingAccountId,
              output.creditProgramRevisionRef, sourceRef, journalRef, output.bucketClass, output.unit,
              output.liabilityMerchantAccountId, output.amount, output.burnPriority, JSON.stringify(output.scopePolicy),
              context.effectAt, expiresAt],
          );
          if (created !== 1) throw new Error("CREDIT_GRANT_CREATE_FAILED");
          await recordGrantIssueJournal(sql, {
            journalRef,
            creditAccountId: creditAccount.creditAccountId,
            siteId: context.input.siteId,
            unit: output.unit,
            businessOperationKey: `redemption:${context.redemptionId}:${output.outputLineId}:${occurrence}`,
            commandId: context.input.commandId,
            creditGrantId: outputRef,
            amount: output.amount,
            occurredAt: context.effectAt,
          });
          receipts.push(Object.freeze({ kind: "credit_grant", outputLineId: output.outputLineId,
            resourceRef: outputRef, templateRevisionRef: output.creditProgramRevisionRef }));
          actual.push(Object.freeze({ outputLineId: output.outputLineId, occurrence,
            templateRevision: output.creditProgramRevisionRef, outputKind: "credit_grant", outputRef }));
        } else {
          if (output.planVersionRef === null || context.subscriptionId === null || context.subscriptionTerm === null) {
            throw new Error("REDEMPTION_OUTPUT_INVALID");
          }
          const outputRef = context.nextRef("subscription_term");
          const created = await sql.execute(
            `INSERT INTO platform.commerce_subscription_term
             (subscription_term_ref,subscription_ref,site_ref,billing_account_ref,plan_version_ref,
              source_type,source_ref,starts_at,ends_at)
             VALUES ($1::uuid,$2::uuid,$3,$4,$5,'redemption',$6,$7::timestamptz,$8::timestamptz)`,
            [outputRef, context.subscriptionId, context.input.siteId, context.preview.billingAccountId,
              output.planVersionRef, outputSourceRef(context.redemptionId, output.outputLineId, occurrence),
              context.subscriptionTerm.startsAt, context.subscriptionTerm.endsAt],
          );
          if (created !== 1) throw new Error("SUBSCRIPTION_TERM_CREATE_FAILED");
          receipts.push(Object.freeze({ kind: "subscription_term", outputLineId: output.outputLineId,
            resourceRef: outputRef, templateRevisionRef: output.planVersionRef }));
          actual.push(Object.freeze({ outputLineId: output.outputLineId, occurrence,
            templateRevision: output.planVersionRef, outputKind: "subscription_term", outputRef }));
        }
      }
    }
    return Object.freeze({ receipts, actual });
  }

  async #lockCreditAccounts(
    transaction: Parameters<RedemptionConfirmationRepository["confirmRedemption"]>[0],
    outputs: readonly OutputRow[],
    siteId: string,
    billingAccountId: string,
  ): Promise<Map<string, PreparedCreditAccount>> {
    const identities = new Map<string, CreditAccountAuthorityIdentity>();
    for (const output of outputs) {
      if (output.outputKind !== "credit_grant") continue;
      if (output.unit === null || output.liabilityMerchantAccountId === null) throw new Error("REDEMPTION_OUTPUT_INVALID");
      const identity = creditIdentity(siteId, billingAccountId, output);
      identities.set(creditAccountAdvisoryKey(identity), identity);
    }
    const locked = new Map<string, PreparedCreditAccount>();
    for (const key of [...identities.keys()].sort((a, b) => a.localeCompare(b, "en"))) {
      const identity = identities.get(key)!;
      locked.set(key, Object.freeze({ identity, account: await lockCreditAccountAuthority(transaction, identity) }));
    }
    return locked;
  }
}

async function loadConfirmation(
  sql: ReturnType<typeof resolvePlatformTransaction>,
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
  const receipt = await loadReceipt(sql, REDEMPTION_RECEIPT_SQL, [command.commandId, siteId], siteId);
  return receipt === null ? null : Object.freeze({
    state: "succeeded" as const,
    receipt: Object.freeze({ ...receipt, commandReceivedAt, commandUpdatedAt }),
  });
}

async function loadReceipt(
  sql: ReturnType<typeof resolvePlatformTransaction>,
  statement: string,
  values: readonly unknown[],
  siteId: string,
): Promise<RedemptionReceiptRecord | null> {
  const redemptions = await sql.query<RedemptionReceiptRow>(statement, values);
  const redemption = redemptions[0];
  if (redemption === undefined || redemptions.length !== 1) return null;
  const storedOutputs = await sql.query<Record<string, unknown> & RedemptionOutputReceipt>(
    REDEMPTION_OUTPUT_RECEIPT_SQL,
    [redemption.fulfillmentRef],
  );
  const outputs = Object.freeze(storedOutputs.map((output) => Object.freeze({
    kind: output.kind,
    outputLineId: output.outputLineId,
    resourceRef: output.resourceRef,
    templateRevisionRef: output.templateRevisionRef,
  })));
  if (digest({ version: 1, outputs }) !== redemption.outputSetDigest) {
    throw new Error("REDEMPTION_OUTPUT_SET_DIGEST_MISMATCH");
  }
  const reversals = await sql.query<Record<string, unknown> & { reversalRef: string }>(
    REDEMPTION_REVERSAL_RECEIPT_SQL,
    [redemption.redemptionId, siteId],
  );
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
    reversalRefs: Object.freeze(reversals.map((row) => row.reversalRef)),
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
    if (output.ordinal !== index || !Number.isInteger(output.cardinality) || output.cardinality < 1 || output.cardinality > 100) {
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
      } else if (output.outputKind === "credit_grant") {
        if (output.creditProgramRevisionRef === null || output.bucketClass === null || output.unit === null || output.amount === null) {
          return false;
        }
        actualCredits.push(commerceCanonicalJson({
          creditProgramRevisionRef: output.creditProgramRevisionRef,
          bucketClass: output.bucketClass,
          unit: output.unit,
          amount: output.amount,
          expiresAt: expiry(instant(preview.createdAt), output.creditExpiresAfterSeconds),
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

function resolveSubscriptionTerm(
  subscription: PreparedSubscription,
  preview: PreviewConfirmationRow,
  safeTerms: RedemptionSafeTerms,
  termSeconds: bigint | string,
  effectAt: string,
): PreparedSubscriptionTerm | null {
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

function outputSourceRef(redemptionId: string, outputLineId: string, occurrence: number): string {
  const value = `${redemptionId}:${outputLineId}:${occurrence}`;
  if (value.length > 256) throw new Error("REDEMPTION_OUTPUT_SOURCE_REF_INVALID");
  return value;
}

function creditIdentity(
  siteId: string,
  billingAccountId: string,
  output: Pick<OutputRow, "unit" | "liabilityMerchantAccountId">,
): CreditAccountAuthorityIdentity {
  if (output.unit === null || output.liabilityMerchantAccountId === null) throw new Error("REDEMPTION_OUTPUT_INVALID");
  return Object.freeze({
    siteId,
    billingAccountId,
    unit: output.unit,
    liabilityMerchantAccountId: output.liabilityMerchantAccountId,
  });
}

async function recordGrantIssueJournal(
  sql: ReturnType<typeof resolvePlatformTransaction>,
  input: Readonly<{
    journalRef: string;
    creditAccountId: string;
    siteId: string;
    unit: string;
    businessOperationKey: string;
    commandId: string;
    creditGrantId: string;
    amount: string;
    occurredAt: string;
  }>,
): Promise<void> {
  if (!/^[1-9][0-9]{0,37}$/u.test(input.amount) || input.businessOperationKey.length > 256) {
    throw new Error("CREDIT_GRANT_JOURNAL_INPUT_INVALID");
  }
  const entries = [
    { entryOrdinal: 0, entrySide: "debit", accountType: "grant_issuance_source" },
    { entryOrdinal: 1, entrySide: "credit", accountType: "customer_available" },
  ] as const;
  const entriesDigest = createHash("sha256").update(entries.map((entry) => [
    entry.entryOrdinal,
    input.siteId,
    input.creditAccountId,
    input.unit,
    entry.entrySide,
    entry.accountType,
    input.amount,
    input.creditGrantId,
    "",
  ].join("|")).join("\n"), "utf8").digest("hex");
  const requestDigest = digest({
    version: 1,
    operationKind: "grant_issue",
    businessOperationKey: input.businessOperationKey,
    creditAccountId: input.creditAccountId,
    creditGrantId: input.creditGrantId,
    amount: input.amount,
    unit: input.unit,
  });
  const journalInserted = await sql.execute(
    `INSERT INTO platform.credit_journal_transaction
     (journal_transaction_ref,credit_account_ref,site_ref,unit,business_operation_key,request_digest,
      operation_kind,expected_entry_count,entries_digest,command_id,occurred_at)
     VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,'grant_issue',2,$7,$8,$9::timestamptz)`,
    [input.journalRef, input.creditAccountId, input.siteId, input.unit, input.businessOperationKey,
      requestDigest, entriesDigest, input.commandId, input.occurredAt],
  );
  if (journalInserted !== 1) throw new Error("CREDIT_GRANT_JOURNAL_CREATE_FAILED");
  for (const entry of entries) {
    const shape = entry.entryOrdinal === 0
      ? "'debit','grant_issuance_source'"
      : "'credit','customer_available'";
    const inserted = await sql.execute(
      `INSERT INTO platform.credit_journal_entry
       (journal_transaction_ref,entry_ordinal,site_ref,credit_account_ref,unit,entry_side,account_type,
        amount,credit_grant_id,credit_hold_ref)
       VALUES ($1::uuid,$2,$3,$4::uuid,$5,${shape},$6::numeric,$7::uuid,NULL)`,
      [input.journalRef, entry.entryOrdinal, input.siteId, input.creditAccountId, input.unit,
        input.amount, input.creditGrantId],
    );
    if (inserted !== 1) throw new Error("CREDIT_GRANT_JOURNAL_ENTRY_CREATE_FAILED");
  }
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
         credit.ux_bucket_class AS "bucketClass",credit.unit,credit.amount::text AS amount,
         credit.expires_after_seconds AS "creditExpiresAfterSeconds",
         credit.liability_merchant_account_ref AS "liabilityMerchantAccountId",
         credit.burn_priority AS "burnPriority",credit.scope_policy AS "scopePolicy",
         output.entitlement_template_revision_ref AS "entitlementTemplateRevisionRef",
         entitlement.capability_key AS "capabilityKey",entitlement.safe_label AS "safeLabel",
         entitlement.expires_after_seconds AS "entitlementExpiresAfterSeconds"
  FROM platform.commerce_fulfillment_program_output output
  LEFT JOIN platform.commerce_credit_program_revision credit
    ON credit.credit_program_revision_ref=output.credit_program_revision_ref AND credit.site_ref=$2
  LEFT JOIN platform.commerce_entitlement_template_revision entitlement
    ON entitlement.entitlement_template_revision_ref=output.entitlement_template_revision_ref AND entitlement.site_ref=$2
  WHERE output.fulfillment_program_revision_ref=$1 AND output.site_ref=$2
    AND (output.output_kind<>'credit_grant' OR credit.credit_program_revision_ref IS NOT NULL)
    AND (output.output_kind<>'entitlement_grant' OR entitlement.entitlement_template_revision_ref IS NOT NULL)
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
    AND fulfillment.status='succeeded'`;

const REDEMPTION_RECEIPT_BY_ID_SQL = `
  SELECT redemption.command_id AS "commandId",redemption.redemption_id AS "redemptionId",
         redemption.fulfillment_ref AS "fulfillmentRef",fulfillment.output_set_digest AS "outputSetDigest",
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
    AND fulfillment.status='succeeded'`;

const REDEMPTION_OUTPUT_RECEIPT_SQL = `
  SELECT actual.output_kind AS kind,actual.output_line_id AS "outputLineId",
         actual.output_ref AS "resourceRef",actual.template_revision AS "templateRevisionRef"
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
    WHERE term.site_ref=$2 AND term.source_type='redemption' AND term.source_ref LIKE $1::text || ':%'
    UNION ALL
    SELECT revocation.entitlement_revocation_ref::text AS reversal_ref
    FROM platform.commerce_entitlement_grant entitlement
    JOIN platform.commerce_entitlement_revocation revocation
      ON revocation.entitlement_grant_ref=entitlement.entitlement_grant_ref AND revocation.site_ref=entitlement.site_ref
    WHERE entitlement.site_ref=$2 AND entitlement.source_type='redemption' AND entitlement.source_ref LIKE $1::text || ':%'
    UNION ALL
    SELECT DISTINCT journal.journal_transaction_ref::text AS reversal_ref
    FROM platform.credit_grant grant_fact
    JOIN platform.credit_journal_entry entry ON entry.credit_grant_id=grant_fact.credit_grant_id
    JOIN platform.credit_journal_transaction journal
      ON journal.journal_transaction_ref=entry.journal_transaction_ref AND journal.site_ref=grant_fact.site_ref
    WHERE grant_fact.site_ref=$2 AND grant_fact.source_type='redemption'
      AND grant_fact.source_ref LIKE $1::text || ':%'
      AND journal.operation_kind IN ('grant_revoke','reversal')
  ) reversal
  ORDER BY reversal_ref`;
