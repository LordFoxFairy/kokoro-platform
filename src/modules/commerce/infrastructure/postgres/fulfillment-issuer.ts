import { createHash } from "node:crypto";
import {
  FulfillmentService,
  type FulfillmentIssuer,
  type FulfillmentOutputReceipt,
  type FulfillmentRepositoryPort,
} from "../../application/services/fulfillment.js";
import type { ActualFulfillmentOutput } from "../../domain/output-line.js";
import { commerceCanonicalJson } from "../../domain/canonical-json.js";
import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";
import {
  creditAccountAdvisoryKey,
  type CreditAccountAuthorityIdentity,
  type LockedCreditAccount,
} from "../../../credit/infrastructure/postgres/credit-account-lock.js";

export type FulfillmentOutputDefinition = Readonly<{
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
  scopePolicy: Readonly<{
    version: 1;
    surfaceRefs: readonly string[];
    capabilityKeys: readonly string[];
    agentRefs: readonly string[];
    allowUnattributedAgent: boolean;
  }> | null;
  entitlementTemplateRevisionRef: string | null;
  capabilityKey: string | null;
  safeLabel: string | null;
  entitlementExpiresAfterSeconds: bigint | null;
}>;

export type PreparedFulfillmentCreditAccount = Readonly<{
  identity: CreditAccountAuthorityIdentity;
  account: LockedCreditAccount | null;
}>;

export type PreparedFulfillmentSubscription = Readonly<{
  subscriptionId: string | null;
  state: "active" | "expired" | "revoked" | null;
  planRef: string | null;
  activeTermEndsAt: string | null;
}>;

export type PostgresFulfillmentMaterialization = Readonly<{
  siteId: string;
  effectAt: string;
  outputs: readonly FulfillmentOutputDefinition[];
  nextRef: (purpose: string) => string;
  creditAccounts: Map<string, PreparedFulfillmentCreditAccount>;
  subscription: PreparedFulfillmentSubscription | null;
  subscriptionTerm: Readonly<{ startsAt: string; endsAt: string }> | null;
  stackingScope: string | null;
  planRef: string | null;
}>;

export class PostgresFulfillmentIssuer implements FulfillmentIssuer<PostgresFulfillmentMaterialization> {
  async issue(
    transaction: Parameters<FulfillmentIssuer<PostgresFulfillmentMaterialization>["issue"]>[0],
    context: Parameters<FulfillmentIssuer<PostgresFulfillmentMaterialization>["issue"]>[1],
  ): ReturnType<FulfillmentIssuer<PostgresFulfillmentMaterialization>["issue"]> {
    const sql = resolvePlatformTransaction(transaction);
    const materialization = context.materialization;
    const outputs: FulfillmentOutputReceipt[] = [];
    const actual: ActualFulfillmentOutput[] = [];
    let subscriptionId = materialization.subscription?.subscriptionId ?? null;
    if (materialization.subscription !== null) {
      if (materialization.stackingScope === null || materialization.planRef === null) {
        throw new Error("FULFILLMENT_SUBSCRIPTION_PLAN_INVALID");
      }
      if (subscriptionId === null) {
        subscriptionId = materialization.nextRef("subscription");
        const created = await sql.execute(
          `INSERT INTO platform.commerce_subscription
           (subscription_ref,site_ref,billing_account_ref,stacking_scope,plan_ref,state)
           VALUES ($1::uuid,$2,$3,$4,$5,'active')`,
          [subscriptionId, materialization.siteId, context.billingAccountId,
            materialization.stackingScope, materialization.planRef],
        );
        if (created !== 1) throw new Error("FULFILLMENT_SUBSCRIPTION_CREATE_FAILED");
      } else if (materialization.subscription.state === "expired") {
        const reactivated = await sql.execute(
          `UPDATE platform.commerce_subscription SET state='active',aggregate_version=aggregate_version+1,updated_at=$3::timestamptz
           WHERE subscription_ref=$1::uuid AND site_ref=$2 AND state='expired'`,
          [subscriptionId, materialization.siteId, materialization.effectAt],
        );
        if (reactivated !== 1) throw new Error("FULFILLMENT_SUBSCRIPTION_REACTIVATION_CONFLICT");
      }
    }
    for (const [key, prepared] of materialization.creditAccounts) {
      if (prepared.account !== null) continue;
      const identity = prepared.identity;
      const creditAccountId = materialization.nextRef("credit_account");
      const created = await sql.execute(
        `INSERT INTO platform.credit_account
         (credit_account_ref,site_ref,billing_account_ref,unit,liability_merchant_account_ref,state)
         VALUES ($1::uuid,$2,$3,$4,$5,'active')`,
        [creditAccountId, identity.siteId, identity.billingAccountId, identity.unit,
          identity.liabilityMerchantAccountId],
      );
      if (created !== 1) throw new Error("FULFILLMENT_CREDIT_ACCOUNT_CREATE_FAILED");
      materialization.creditAccounts.set(key, Object.freeze({ identity, account: Object.freeze({
        creditAccountId, state: "active" as const, aggregateVersion: 1n,
      }) }));
    }
    for (const output of materialization.outputs) {
      for (let occurrence = 1; occurrence <= output.cardinality; occurrence += 1) {
        if (output.outputKind === "entitlement_grant") {
          if (output.entitlementTemplateRevisionRef === null || output.capabilityKey === null || output.safeLabel === null) {
            throw new Error("FULFILLMENT_OUTPUT_INVALID");
          }
          const outputRef = materialization.nextRef("entitlement_grant");
          const expiresAt = expiry(materialization.effectAt, output.entitlementExpiresAfterSeconds);
          await sql.execute(
            `INSERT INTO platform.commerce_entitlement_grant
             (entitlement_grant_ref,site_ref,billing_account_ref,entitlement_template_revision_ref,
              capability_key,safe_label,source_type,source_ref,effective_at,expires_at)
             VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10::timestamptz)`,
            [outputRef, materialization.siteId, context.billingAccountId,
              output.entitlementTemplateRevisionRef, output.capabilityKey, output.safeLabel,
              context.source.sourceType,
              outputSourceRef(context.source.idempotencyKey, output.outputLineId, occurrence),
              materialization.effectAt, expiresAt],
          );
          outputs.push(Object.freeze({ kind: "entitlement_grant", outputLineId: output.outputLineId,
            resourceRef: outputRef, templateRevisionRef: output.entitlementTemplateRevisionRef }));
          actual.push(Object.freeze({ outputLineId: output.outputLineId, occurrence,
            templateRevision: output.entitlementTemplateRevisionRef, outputKind: "entitlement_grant", outputRef }));
        } else if (output.outputKind === "credit_grant") {
          if (output.creditProgramRevisionRef === null || output.bucketClass === null || output.unit === null ||
            output.amount === null || output.liabilityMerchantAccountId === null || output.burnPriority === null ||
            output.scopePolicy === null) {
            throw new Error("FULFILLMENT_OUTPUT_INVALID");
          }
          const identity = fulfillmentCreditAccountIdentity(materialization.siteId, context.billingAccountId, output);
          const creditAccount = materialization.creditAccounts.get(creditAccountAdvisoryKey(identity))?.account;
          if (creditAccount === undefined || creditAccount === null || creditAccount.state !== "active") {
            throw new Error("FULFILLMENT_CREDIT_ACCOUNT_AUTHORITY_MISSING");
          }
          const outputRef = materialization.nextRef("credit_grant");
          const journalRef = materialization.nextRef("grant_issue_journal");
          const sourceRef = outputSourceRef(context.source.idempotencyKey, output.outputLineId, occurrence);
          const expiresAt = expiry(materialization.effectAt, output.creditExpiresAfterSeconds);
          const created = await sql.execute(
            `INSERT INTO platform.credit_grant
             (credit_grant_id,credit_account_ref,site_ref,billing_account_ref,credit_program_revision_ref,
              source_type,source_ref,issuance_journal_transaction_ref,ux_bucket_class,unit,
              liability_merchant_account_ref,original_amount,burn_priority,scope_policy,effective_at,expires_at,issued_at)
             VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8::uuid,$9,$10,$11,$12::numeric,$13,$14::jsonb,
                     $15::timestamptz,$16::timestamptz,$15::timestamptz)`,
            [outputRef, creditAccount.creditAccountId, materialization.siteId, context.billingAccountId,
              output.creditProgramRevisionRef, context.source.sourceType, sourceRef, journalRef, output.bucketClass, output.unit,
              output.liabilityMerchantAccountId, output.amount, output.burnPriority, JSON.stringify(output.scopePolicy),
              materialization.effectAt, expiresAt],
          );
          if (created !== 1) throw new Error("FULFILLMENT_CREDIT_GRANT_CREATE_FAILED");
          await recordGrantIssueJournal(sql, {
            journalRef,
            creditAccountId: creditAccount.creditAccountId,
            siteId: materialization.siteId,
            unit: output.unit,
            businessOperationKey: `fulfillment:${context.source.idempotencyKey}:${output.outputLineId}:${occurrence}`,
            commandId: context.commandId,
            creditGrantId: outputRef,
            amount: output.amount,
            occurredAt: materialization.effectAt,
          });
          outputs.push(Object.freeze({ kind: "credit_grant", outputLineId: output.outputLineId,
            resourceRef: outputRef, templateRevisionRef: output.creditProgramRevisionRef }));
          actual.push(Object.freeze({ outputLineId: output.outputLineId, occurrence,
            templateRevision: output.creditProgramRevisionRef, outputKind: "credit_grant", outputRef }));
        } else {
          if (output.planVersionRef === null || subscriptionId === null || materialization.subscriptionTerm === null) {
            throw new Error("FULFILLMENT_OUTPUT_INVALID");
          }
          const outputRef = materialization.nextRef("subscription_term");
          const created = await sql.execute(
            `INSERT INTO platform.commerce_subscription_term
             (subscription_term_ref,subscription_ref,site_ref,billing_account_ref,plan_version_ref,
              source_type,source_ref,starts_at,ends_at)
             VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8::timestamptz,$9::timestamptz)`,
            [outputRef, subscriptionId, materialization.siteId, context.billingAccountId,
              output.planVersionRef, context.source.sourceType,
              outputSourceRef(context.source.idempotencyKey, output.outputLineId, occurrence),
              materialization.subscriptionTerm.startsAt, materialization.subscriptionTerm.endsAt],
          );
          if (created !== 1) throw new Error("FULFILLMENT_SUBSCRIPTION_TERM_CREATE_FAILED");
          outputs.push(Object.freeze({ kind: "subscription_term", outputLineId: output.outputLineId,
            resourceRef: outputRef, templateRevisionRef: output.planVersionRef }));
          actual.push(Object.freeze({ outputLineId: output.outputLineId, occurrence,
            templateRevision: output.planVersionRef, outputKind: "subscription_term", outputRef }));
        }
      }
    }
    return Object.freeze({ outputs, actual });
  }
}

export function createPostgresFulfillmentService(
  repository: FulfillmentRepositoryPort,
): FulfillmentService<PostgresFulfillmentMaterialization> {
  return new FulfillmentService({ repository, issuer: new PostgresFulfillmentIssuer() });
}

export function fulfillmentCreditAccountIdentity(
  siteId: string,
  billingAccountId: string,
  output: Pick<FulfillmentOutputDefinition, "unit" | "liabilityMerchantAccountId">,
): CreditAccountAuthorityIdentity {
  if (output.unit === null || output.liabilityMerchantAccountId === null) {
    throw new Error("FULFILLMENT_OUTPUT_INVALID");
  }
  return Object.freeze({
    siteId,
    billingAccountId,
    unit: output.unit,
    liabilityMerchantAccountId: output.liabilityMerchantAccountId,
  });
}

function outputSourceRef(fulfillmentIdempotencyKey: string, outputLineId: string, occurrence: number): string {
  const value = `${fulfillmentIdempotencyKey}:${outputLineId}:${occurrence}`;
  if (value.length > 256) throw new Error("FULFILLMENT_OUTPUT_SOURCE_REF_INVALID");
  return value;
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
  if (value > 8_640_000_000_000_000n) throw new Error("FULFILLMENT_EXPIRY_INVALID");
  return new Date(Number(value)).toISOString();
}

function digest(value: Parameters<typeof commerceCanonicalJson>[0]): string {
  return createHash("sha256").update(commerceCanonicalJson(value), "utf8").digest("hex");
}
