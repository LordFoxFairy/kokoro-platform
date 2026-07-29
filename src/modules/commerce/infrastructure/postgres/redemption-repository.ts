import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";
import type { RedemptionRepository } from "../../application/contracts/redemption-repository.js";
import {
  redemptionSafeTermsSchema,
  type RedemptionSafeTerms,
  type StoredRedemptionPreview,
} from "../../domain/redemption-preview.js";

type CandidateRow = Record<string, unknown> & {
  codeRef: string;
  batchRef: string;
  redemptionProgramRevisionRef: string;
  fulfillmentProgramRevisionRef: string;
  productRevisionDigest: string;
  programDigest: string;
  outputPlanDigest: string;
  safeCodeFingerprint: string;
  productRef: string;
  productVersionRef: string;
  productKind: RedemptionSafeTerms["productKind"];
  safeProductLabel: string;
  planRef: string | null;
  planVersionRef: string | null;
  safePlanLabel: string | null;
  termAction: RedemptionSafeTerms["term"]["action"] | null;
  termSeconds: bigint | null;
  activeTermEndsAt: Date | string | null;
  legalTermRefs: string[];
};

type OutputRow = Record<string, unknown> & {
  outputKind: "subscription_term" | "entitlement_grant" | "credit_grant";
  ordinal: number;
  cardinality: number;
  creditProgramRevisionRef: string | null;
  bucketClass: "daily" | "period" | "permanent" | null;
  unit: string | null;
  amount: string | null;
  creditExpiresAfterSeconds: bigint | null;
  entitlementTemplateRevisionRef: string | null;
  capabilityKey: string | null;
  safeLabel: string | null;
  entitlementExpiresAfterSeconds: bigint | null;
};

type PreviewRow = Record<string, unknown> & {
  previewRef: string;
  commandId: string;
  siteId: string;
  subjectId: string;
  subjectGeneration: bigint;
  billingAccountId: string;
  codeRef: string;
  batchRef: string;
  redemptionProgramRevisionRef: string;
  fulfillmentProgramRevisionRef: string;
  productRevisionDigest: string;
  programDigest: string;
  outputPlanDigest: string;
  safeCodeFingerprint: string;
  previewDigest: string;
  credentialKeyRevision: string;
  credentialDigest: string;
  safeTerms: unknown;
  state: StoredRedemptionPreview["state"];
  expiresAt: Date | string;
  createdAt: Date | string;
};

export class PostgresRedemptionRepository implements RedemptionRepository {
  async resolvePreviewCandidate(
    transaction: Parameters<RedemptionRepository["resolvePreviewCandidate"]>[0],
    input: Parameters<RedemptionRepository["resolvePreviewCandidate"]>[1],
  ): ReturnType<RedemptionRepository["resolvePreviewCandidate"]> {
    if (input.lookupCandidates.length < 1 || input.lookupCandidates.length > 16) {
      throw new Error("REDEMPTION_LOOKUP_KEY_RING_INVALID");
    }
    const sql = resolvePlatformTransaction(transaction);
    const rows = await sql.query<CandidateRow>(CANDIDATE_SQL, [
      input.siteId,
      JSON.stringify(input.lookupCandidates.map((item) => ({
        key_revision: item.keyRevision,
        lookup_digest: item.lookupDigest,
      }))),
      input.now,
      input.billingAccountId,
    ]);
    const row = rows[0];
    if (row === undefined) return null;
    if (rows.length !== 1) throw new Error("REDEMPTION_CODE_LOOKUP_AMBIGUOUS");
    const outputRows = await sql.query<OutputRow>(OUTPUT_SQL, [row.fulfillmentProgramRevisionRef, input.siteId]);
    const safeTerms = terms(row, outputRows, input.now);
    return Object.freeze({
      codeRef: row.codeRef,
      batchRef: row.batchRef,
      redemptionProgramRevisionRef: row.redemptionProgramRevisionRef,
      fulfillmentProgramRevisionRef: row.fulfillmentProgramRevisionRef,
      productRevisionDigest: row.productRevisionDigest,
      programDigest: row.programDigest,
      outputPlanDigest: row.outputPlanDigest,
      safeCodeFingerprint: row.safeCodeFingerprint,
      safeTerms,
    });
  }

  async resolvePreviewBillingAccount(
    transaction: Parameters<RedemptionRepository["resolvePreviewBillingAccount"]>[0],
    input: Parameters<RedemptionRepository["resolvePreviewBillingAccount"]>[1],
  ): ReturnType<RedemptionRepository["resolvePreviewBillingAccount"]> {
    const rows = await resolvePlatformTransaction(transaction).query<Record<string, unknown> & {
      billingAccountId: string;
      aggregateVersion: bigint;
      membershipEpoch: bigint;
      subjectGeneration: bigint;
    }>(
      `SELECT account.billing_account_ref AS "billingAccountId",account.aggregate_version AS "aggregateVersion",
              membership.membership_epoch AS "membershipEpoch",membership.subject_generation AS "subjectGeneration"
       FROM platform.commerce_billing_account_membership membership
       JOIN platform.commerce_billing_account account
         ON account.billing_account_ref=membership.billing_account_ref AND account.site_ref=membership.site_ref
       WHERE membership.site_ref=$1 AND membership.subject_ref=$2 AND membership.is_default=TRUE
         AND membership.state='active' AND account.state='active'`,
      [input.siteId, input.subjectId],
    );
    const row = rows[0];
    if (row === undefined || rows.length !== 1 || row.subjectGeneration.toString() !== input.subjectGeneration) return null;
    return Object.freeze({
      billingAccountId: row.billingAccountId,
      aggregateVersion: row.aggregateVersion.toString(),
      membershipEpoch: row.membershipEpoch.toString(),
    });
  }

  async savePreview(
    transaction: Parameters<RedemptionRepository["savePreview"]>[0],
    input: Parameters<RedemptionRepository["savePreview"]>[1],
  ): Promise<void> {
    const changed = await resolvePlatformTransaction(transaction).execute(
      `INSERT INTO platform.commerce_redemption_preview
       (preview_ref,command_id,site_ref,subject_ref,subject_generation,billing_account_ref,code_ref,batch_ref,
        redemption_program_revision_ref,product_version_ref,plan_version_ref,fulfillment_program_revision_ref,
        product_revision_digest,program_digest,output_plan_digest,preview_digest,credential_key_revision,
        credential_digest,safe_terms,state,expires_at,created_at)
       VALUES ($1::uuid,$2,$3,$4,$5::bigint,$6,$7::uuid,$8::uuid,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,'live',$20::timestamptz,$21::timestamptz)`,
      [input.previewRef, input.commandId, input.siteId, input.subjectId, input.subjectGeneration,
        input.billingAccountId, input.codeRef, input.batchRef, input.redemptionProgramRevisionRef,
        input.safeTerms.productVersionRef, input.safeTerms.planVersionRef, input.fulfillmentProgramRevisionRef,
        input.productRevisionDigest, input.programDigest, input.outputPlanDigest, input.previewDigest,
        input.credentialKeyRevision, input.credentialDigest, JSON.stringify(input.safeTerms), input.expiresAt, input.createdAt],
    );
    if (changed !== 1) throw new Error("REDEMPTION_PREVIEW_PERSIST_FAILED");
  }

  async findPreviewByCommand(
    transaction: Parameters<RedemptionRepository["findPreviewByCommand"]>[0],
    input: Parameters<RedemptionRepository["findPreviewByCommand"]>[1],
  ): ReturnType<RedemptionRepository["findPreviewByCommand"]> {
    const rows = await resolvePlatformTransaction(transaction).query<PreviewRow>(
      `SELECT preview.preview_ref AS "previewRef",preview.command_id AS "commandId",preview.site_ref AS "siteId",
              preview.subject_ref AS "subjectId",preview.subject_generation AS "subjectGeneration",
              preview.billing_account_ref AS "billingAccountId",preview.code_ref AS "codeRef",preview.batch_ref AS "batchRef",
              preview.redemption_program_revision_ref AS "redemptionProgramRevisionRef",
              preview.fulfillment_program_revision_ref AS "fulfillmentProgramRevisionRef",
              preview.product_revision_digest AS "productRevisionDigest",preview.program_digest AS "programDigest",
              preview.output_plan_digest AS "outputPlanDigest",preview.preview_digest AS "previewDigest",
              code.safe_fingerprint AS "safeCodeFingerprint",
              preview.credential_key_revision AS "credentialKeyRevision",preview.credential_digest AS "credentialDigest",
              preview.safe_terms AS "safeTerms",preview.state,preview.expires_at AS "expiresAt",preview.created_at AS "createdAt"
       FROM platform.commerce_redemption_preview preview
       JOIN platform.commerce_redeem_code code ON code.code_ref=preview.code_ref AND code.site_ref=preview.site_ref
       WHERE preview.command_id=$1 AND preview.site_ref=$2 AND preview.subject_ref=$3 AND preview.subject_generation=$4::bigint`,
      [input.commandId, input.siteId, input.subjectId, input.subjectGeneration],
    );
    const row = rows[0];
    if (row === undefined || rows.length !== 1) return null;
    return Object.freeze({
      ...row,
      subjectGeneration: row.subjectGeneration.toString(),
      safeTerms: redemptionSafeTermsSchema.parse(row.safeTerms),
      expiresAt: instant(row.expiresAt),
      createdAt: instant(row.createdAt),
    });
  }
}

function terms(row: CandidateRow, outputs: readonly OutputRow[], now: string): RedemptionSafeTerms {
  if (outputs.length < 1 || outputs.length > 256) throw new Error("REDEMPTION_PROGRAM_OUTPUT_INVALID");
  const credits: RedemptionSafeTerms["credits"] = [];
  const entitlements: RedemptionSafeTerms["entitlements"] = [];
  let subscriptionTermCount = 0;
  outputs.forEach((output, index) => {
    if (output.ordinal !== index || !Number.isInteger(output.cardinality) || output.cardinality < 1 || output.cardinality > 100) {
      throw new Error("REDEMPTION_PROGRAM_OUTPUT_INVALID");
    }
    if (output.outputKind === "credit_grant") {
      if (output.creditProgramRevisionRef === null || output.bucketClass === null || output.unit === null || output.amount === null) {
        throw new Error("REDEMPTION_PROGRAM_OUTPUT_INVALID");
      }
      for (let occurrence = 0; occurrence < output.cardinality; occurrence += 1) {
        credits.push(Object.freeze({
          creditProgramRevisionRef: output.creditProgramRevisionRef,
          bucketClass: output.bucketClass,
          unit: output.unit,
          amount: output.amount,
          expiresAt: expiry(now, output.creditExpiresAfterSeconds),
        }));
      }
    } else if (output.outputKind === "entitlement_grant") {
      if (output.entitlementTemplateRevisionRef === null || output.capabilityKey === null || output.safeLabel === null) {
        throw new Error("REDEMPTION_PROGRAM_OUTPUT_INVALID");
      }
      for (let occurrence = 0; occurrence < output.cardinality; occurrence += 1) {
        entitlements.push(Object.freeze({
          entitlementTemplateRevisionRef: output.entitlementTemplateRevisionRef,
          capabilityKey: output.capabilityKey,
          safeLabel: output.safeLabel,
          expiresAt: expiry(now, output.entitlementExpiresAfterSeconds),
        }));
      }
    } else {
      if (output.cardinality !== 1) throw new Error("REDEMPTION_PROGRAM_OUTPUT_INVALID");
      subscriptionTermCount += 1;
    }
  });
  const activeTermEndsAt = row.activeTermEndsAt === null ? null : instant(row.activeTermEndsAt);
  const hasActiveTerm = activeTermEndsAt !== null && Date.parse(activeTermEndsAt) > Date.parse(now);
  if ((row.termAction === "new_subscription" || row.termAction === "reject_if_active") && hasActiveTerm) {
    throw new Error("REDEEM_NOT_ACCEPTED");
  }
  if ((row.termAction === null || row.termAction === "none") !== (subscriptionTermCount === 0)) {
    throw new Error("REDEMPTION_PROGRAM_OUTPUT_INVALID");
  }
  const start = row.termAction === null || row.termAction === "none"
    ? null
    : row.termAction === "extend_from_max" && hasActiveTerm ? activeTermEndsAt : now;
  const end = start === null ? null : expiry(start, row.termSeconds);
  return redemptionSafeTermsSchema.parse({
    productRef: row.productRef,
    productVersionRef: row.productVersionRef,
    productKind: row.productKind,
    safeProductLabel: row.safeProductLabel,
    planRef: row.planRef,
    planVersionRef: row.planVersionRef,
    safePlanLabel: row.safePlanLabel,
    term: { action: row.termAction ?? "none", startsAt: start, endsAt: end, automaticRenewal: false },
    credits,
    entitlements,
    legalTermRefs: row.legalTermRefs,
  });
}

function expiry(now: string, seconds: bigint | null): string | null {
  if (seconds === null) return null;
  const milliseconds = BigInt(Date.parse(now)) + seconds * 1000n;
  if (milliseconds > BigInt(8_640_000_000_000_000)) throw new Error("REDEMPTION_EXPIRY_INVALID");
  return new Date(Number(milliseconds)).toISOString();
}

function instant(value: string | Date): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("REDEMPTION_TIMESTAMP_INVALID");
  return parsed.toISOString();
}

const CANDIDATE_SQL = `
  SELECT code.code_ref AS "codeRef",code.batch_ref AS "batchRef",
         program.redemption_program_revision_ref AS "redemptionProgramRevisionRef",
         program.fulfillment_program_revision_ref AS "fulfillmentProgramRevisionRef",
         product_version.revision_digest AS "productRevisionDigest",program.program_digest AS "programDigest",
         fulfillment.output_plan_digest AS "outputPlanDigest",code.safe_fingerprint AS "safeCodeFingerprint",
         product.product_ref AS "productRef",product_version.product_version_ref AS "productVersionRef",
         product.kind AS "productKind",product_version.safe_label AS "safeProductLabel",
         plan.plan_ref AS "planRef",plan_version.plan_version_ref AS "planVersionRef",
         plan_version.safe_label AS "safePlanLabel",plan_version.term_action AS "termAction",
         plan_version.term_seconds AS "termSeconds",active_term.ends_at AS "activeTermEndsAt",
         product_version.legal_term_refs AS "legalTermRefs"
  FROM jsonb_to_recordset($2::jsonb) AS lookup(key_revision TEXT,lookup_digest TEXT)
  JOIN platform.commerce_redeem_code code
    ON code.site_ref=$1 AND code.code_lookup_key_revision=lookup.key_revision
      AND code.lookup_digest=lookup.lookup_digest AND code.state='available'
  JOIN platform.commerce_code_batch batch
    ON batch.batch_ref=code.batch_ref AND batch.site_ref=code.site_ref AND batch.state='active'
      AND (batch.starts_at IS NULL OR batch.starts_at <= $3::timestamptz)
      AND (batch.ends_at IS NULL OR batch.ends_at > $3::timestamptz)
  JOIN platform.commerce_redemption_program_revision program
    ON program.redemption_program_revision_ref=batch.redemption_program_revision_ref
      AND program.site_ref=batch.site_ref
  JOIN platform.commerce_redemption_program_availability availability
    ON availability.redemption_program_revision_ref=program.redemption_program_revision_ref
      AND availability.site_ref=program.site_ref AND availability.state='active'
      AND (availability.starts_at IS NULL OR availability.starts_at <= $3::timestamptz)
      AND (availability.ends_at IS NULL OR availability.ends_at > $3::timestamptz)
  JOIN platform.commerce_catalog_product_version product_version
    ON product_version.product_version_ref=program.product_version_ref
      AND product_version.site_ref=program.site_ref
  JOIN platform.commerce_catalog_product product
    ON product.site_ref=product_version.site_ref AND product.product_ref=product_version.product_ref
      AND product.state='active'
  JOIN platform.commerce_fulfillment_program_revision fulfillment
    ON fulfillment.fulfillment_program_revision_ref=program.fulfillment_program_revision_ref
      AND fulfillment.site_ref=program.site_ref
      AND fulfillment.fulfillment_program_revision_ref=product_version.fulfillment_program_revision_ref
  LEFT JOIN platform.commerce_catalog_plan_version plan_version
    ON plan_version.plan_version_ref=product_version.plan_version_ref
      AND plan_version.site_ref=product_version.site_ref
  LEFT JOIN platform.commerce_catalog_plan plan
    ON plan.site_ref=plan_version.site_ref AND plan.plan_ref=plan_version.plan_ref AND plan.state='active'
  LEFT JOIN platform.commerce_subscription subscription
    ON subscription.site_ref=program.site_ref AND subscription.billing_account_ref=$4
      AND subscription.stacking_scope=plan_version.stacking_scope AND subscription.state='active'
  LEFT JOIN LATERAL (
    SELECT max(term.ends_at) AS ends_at
    FROM platform.commerce_subscription_term term
    WHERE term.subscription_ref=subscription.subscription_ref AND term.site_ref=subscription.site_ref
      AND term.state='active'
  ) active_term ON TRUE
  LEFT JOIN LATERAL (
    SELECT count(*)::INTEGER AS redemption_count
    FROM platform.commerce_redemption redemption
    WHERE redemption.site_ref=program.site_ref AND redemption.billing_account_ref=$4
      AND redemption.redemption_program_revision_ref=program.redemption_program_revision_ref
      AND redemption.state IN ('fulfilled','reversed','reconciliation_required')
  ) account_redemptions ON TRUE
  WHERE (product_version.plan_version_ref IS NULL OR plan_version.plan_version_ref IS NOT NULL)
    AND account_redemptions.redemption_count < program.max_redemptions_per_account`;

const OUTPUT_SQL = `
  SELECT output.output_kind AS "outputKind",output.ordinal,output.cardinality,
         output.credit_program_revision_ref AS "creditProgramRevisionRef",
         credit.bucket_class AS "bucketClass",credit.unit,credit.amount::text AS amount,
         credit.expires_after_seconds AS "creditExpiresAfterSeconds",
         output.entitlement_template_revision_ref AS "entitlementTemplateRevisionRef",
         entitlement.capability_key AS "capabilityKey",entitlement.safe_label AS "safeLabel",
         entitlement.expires_after_seconds AS "entitlementExpiresAfterSeconds"
  FROM platform.commerce_fulfillment_program_output output
  LEFT JOIN platform.commerce_credit_program_revision credit
    ON credit.credit_program_revision_ref=output.credit_program_revision_ref
      AND credit.site_ref=$2
  LEFT JOIN platform.commerce_entitlement_template_revision entitlement
    ON entitlement.entitlement_template_revision_ref=output.entitlement_template_revision_ref
      AND entitlement.site_ref=$2
  WHERE output.fulfillment_program_revision_ref=$1 AND output.site_ref=$2
    AND (output.output_kind<>'credit_grant' OR credit.credit_program_revision_ref IS NOT NULL)
    AND (output.output_kind<>'entitlement_grant' OR entitlement.entitlement_template_revision_ref IS NOT NULL)
  ORDER BY output.ordinal`;
