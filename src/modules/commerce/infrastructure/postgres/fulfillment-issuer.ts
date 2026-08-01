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
import type {
  CreditGrantAccountIdentity,
  CreditGrantIssue,
  CreditGrantIssuancePort,
  PreparedCreditGrantIssuance,
} from "../../../credit/application/contracts/grant-issuance.js";

export type FulfillmentOutputDefinition = Readonly<{
  outputLineId: string;
  outputKind: "subscription_term" | "entitlement_grant" | "credit_grant";
  ordinal: number;
  cardinality: number;
  planVersionRef: string | null;
  creditProgramRevisionRef: string | null;
  creditProgramRevisionVersion: bigint | null;
  creditProgramRevisionDigest: string | null;
  ownerRevision: bigint;
  ownerRevisionDigest: string;
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
  creditGrantPreparation: PreparedCreditGrantIssuance | null;
  subscription: PreparedFulfillmentSubscription | null;
  subscriptionTerm: Readonly<{ startsAt: string; endsAt: string }> | null;
  stackingScope: string | null;
  planRef: string | null;
}>;

type OrderedFulfillmentOutput =
  | Readonly<{
    kind: "materialized";
    receipt: FulfillmentOutputReceipt;
    actual: ActualFulfillmentOutput;
  }>
  | Readonly<{
    kind: "credit_pending";
    outputLineId: string;
    occurrence: number;
    creditProgramRevisionRef: string;
  }>;

export class PostgresFulfillmentIssuer implements FulfillmentIssuer<PostgresFulfillmentMaterialization> {
  constructor(private readonly creditGrants: CreditGrantIssuancePort) {}

  async issue(
    transaction: Parameters<FulfillmentIssuer<PostgresFulfillmentMaterialization>["issue"]>[0],
    context: Parameters<FulfillmentIssuer<PostgresFulfillmentMaterialization>["issue"]>[1],
  ): ReturnType<FulfillmentIssuer<PostgresFulfillmentMaterialization>["issue"]> {
    const sql = resolvePlatformTransaction(transaction);
    const materialization = context.materialization;
    const ordered: OrderedFulfillmentOutput[] = [];
    const creditIssues: CreditGrantIssue[] = [];
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
          ordered.push(Object.freeze({
            kind: "materialized" as const,
            receipt: outputCommitment("entitlement_grant", output, occurrence, outputRef,
              output.entitlementTemplateRevisionRef),
            actual: actualCommitment("entitlement_grant", output, occurrence, outputRef,
              output.entitlementTemplateRevisionRef),
          }));
        } else if (output.outputKind === "credit_grant") {
          if (output.creditProgramRevisionRef === null || output.bucketClass === null || output.unit === null ||
            output.amount === null || output.liabilityMerchantAccountId === null || output.burnPriority === null ||
            output.scopePolicy === null) {
            throw new Error("FULFILLMENT_OUTPUT_INVALID");
          }
          const sourceRef = outputSourceRef(context.source.idempotencyKey, output.outputLineId, occurrence);
          const expiresAt = expiry(materialization.effectAt, output.creditExpiresAfterSeconds);
          creditIssues.push(Object.freeze({
            account: fulfillmentCreditAccountIdentity(materialization.siteId, context.billingAccountId, output),
            outputLineId: output.outputLineId,
            outputOrdinal: output.ordinal,
            occurrence,
            creditProgramRevisionRef: output.creditProgramRevisionRef,
            creditProgramRevision: output.creditProgramRevisionVersion!,
            creditProgramRevisionDigest: output.creditProgramRevisionDigest!,
            sourceType: context.source.sourceType,
            sourceRef,
            businessOperationKey: `fulfillment:${context.source.idempotencyKey}:${output.outputLineId}:${occurrence}`,
            bucketClass: output.bucketClass,
            amount: output.amount,
            burnPriority: output.burnPriority,
            scopePolicy: output.scopePolicy,
            acquiredAt: materialization.effectAt,
            effectiveAt: materialization.effectAt,
            expiresAt,
          }));
          ordered.push(Object.freeze({ kind: "credit_pending" as const, outputLineId: output.outputLineId,
            occurrence, creditProgramRevisionRef: output.creditProgramRevisionRef }));
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
          ordered.push(Object.freeze({
            kind: "materialized" as const,
            receipt: outputCommitment("subscription_term", output, occurrence, outputRef, output.planVersionRef),
            actual: actualCommitment("subscription_term", output, occurrence, outputRef, output.planVersionRef),
          }));
        }
      }
    }
    if ((creditIssues.length === 0) !== (materialization.creditGrantPreparation === null)) {
      throw new Error("FULFILLMENT_CREDIT_GRANT_PREPARATION_MISMATCH");
    }
    const creditReceipts = creditIssues.length === 0 ? [] : await this.creditGrants.issuePrepared(transaction, {
      preparation: materialization.creditGrantPreparation!,
    });
    if (creditReceipts.length !== creditIssues.length) {
      throw new Error("FULFILLMENT_CREDIT_GRANT_RECEIPT_INVALID");
    }
    const creditByOccurrence = new Map<string, (typeof creditReceipts)[number]>();
    const expectedCreditOrdinals = new Map(creditIssues.map((issue) =>
      [`${issue.outputLineId}:${issue.occurrence}`, issue.outputOrdinal] as const));
    for (const receipt of creditReceipts) {
      const key = `${receipt.outputOrdinal}:${receipt.outputLineId}:${receipt.occurrence}`;
      if (creditByOccurrence.has(key)) throw new Error("FULFILLMENT_CREDIT_GRANT_RECEIPT_INVALID");
      creditByOccurrence.set(key, receipt);
    }
    const outputs: FulfillmentOutputReceipt[] = [];
    const actual: ActualFulfillmentOutput[] = [];
    for (const output of ordered) {
      if (output.kind === "materialized") {
        outputs.push(output.receipt);
        actual.push(output.actual);
        continue;
      }
      const expectedOrdinal = expectedCreditOrdinals.get(`${output.outputLineId}:${output.occurrence}`);
      const receipt = expectedOrdinal === undefined ? undefined :
        creditByOccurrence.get(`${expectedOrdinal}:${output.outputLineId}:${output.occurrence}`);
      if (receipt === undefined || receipt.creditProgramRevisionRef !== output.creditProgramRevisionRef) {
        throw new Error("FULFILLMENT_CREDIT_GRANT_RECEIPT_INVALID");
      }
      outputs.push(Object.freeze({ kind: "credit_grant", outputLineId: output.outputLineId,
        outputOrdinal: receipt.outputOrdinal, occurrence: output.occurrence, resourceRef: receipt.creditGrantRef,
        templateRevisionRef: output.creditProgramRevisionRef, outputVersion: receipt.outputVersion,
        outputDigest: receipt.outputDigest }));
      actual.push(Object.freeze({ outputLineId: output.outputLineId, outputOrdinal: receipt.outputOrdinal,
        occurrence: output.occurrence, templateRevision: output.creditProgramRevisionRef,
        outputKind: "credit_grant", outputRef: receipt.creditGrantRef,
        outputVersion: receipt.outputVersion, outputDigest: receipt.outputDigest }));
    }
    return Object.freeze({ outputs, actual });
  }
}

export function createPostgresFulfillmentService(
  repository: FulfillmentRepositoryPort,
  creditGrants: CreditGrantIssuancePort,
): FulfillmentService<PostgresFulfillmentMaterialization> {
  return new FulfillmentService({ repository, issuer: new PostgresFulfillmentIssuer(creditGrants) });
}

export function fulfillmentCreditAccountIdentity(
  siteId: string,
  billingAccountId: string,
  output: Pick<FulfillmentOutputDefinition, "unit" | "liabilityMerchantAccountId">,
): CreditGrantAccountIdentity {
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

function expiry(start: string, seconds: bigint | null): string | null {
  if (seconds === null) return null;
  const value = BigInt(Date.parse(start)) + seconds * 1000n;
  if (value > 8_640_000_000_000_000n) throw new Error("FULFILLMENT_EXPIRY_INVALID");
  return new Date(Number(value)).toISOString();
}

function outputCommitment(
  kind: "subscription_term" | "entitlement_grant",
  output: FulfillmentOutputDefinition,
  occurrence: number,
  resourceRef: string,
  templateRevisionRef: string,
): FulfillmentOutputReceipt {
  const outputVersion = 1 as const;
  const outputDigest = digest({ version: 1, kind, outputLineId: output.outputLineId,
    outputOrdinal: output.ordinal, occurrence, resourceRef, templateRevisionRef, outputVersion });
  return Object.freeze({ kind, outputLineId: output.outputLineId, outputOrdinal: output.ordinal, occurrence,
    resourceRef, templateRevisionRef, outputVersion, outputDigest });
}

function actualCommitment(
  outputKind: "subscription_term" | "entitlement_grant",
  output: FulfillmentOutputDefinition,
  occurrence: number,
  outputRef: string,
  templateRevision: string,
): ActualFulfillmentOutput {
  const receipt = outputCommitment(outputKind, output, occurrence, outputRef, templateRevision);
  return Object.freeze({ outputLineId: receipt.outputLineId, outputOrdinal: receipt.outputOrdinal,
    occurrence: receipt.occurrence, templateRevision, outputKind, outputRef,
    outputVersion: receipt.outputVersion, outputDigest: receipt.outputDigest });
}

function digest(value: Parameters<typeof commerceCanonicalJson>[0]): string {
  return createHash("sha256").update(commerceCanonicalJson(value), "utf8").digest("hex");
}
