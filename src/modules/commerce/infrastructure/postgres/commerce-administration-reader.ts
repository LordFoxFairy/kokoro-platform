import type { AdminQueryPermit } from "../../../admin/interfaces/connect/admin-query-service.js";
import type { AdminQueryTransactionHost } from
  "../../../admin/infrastructure/postgres/admin-query-reader.js";
import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";
import type {
  CreditGrantProgramAdministrationReader,
  CreditGrantProgramAdministrationRecord,
} from "../../../credit/application/contracts/grant-program-administration-reader.js";

export type CommerceOfferRecord = Readonly<{
  siteId: string; productRef: string; productKind: "free" | "credit_pack" | "subscription" | "bundle";
  productVersionRef: string; revision: bigint; safeLabel: string; planVersionRef: string | null;
  fulfillmentProgramRevisionRef: string;
  outputs: readonly Readonly<{ outputLineId: string; ordinal: number; cardinality: number;
    outputKind: "subscription_term" | "entitlement_grant" | "credit_grant" | "credit_program_enrollment";
    targetRevisionRef: string }>[];
  legalTermRefs: readonly string[]; publishedAt: string;
}>;

export type RedemptionProgramRecord = Readonly<{
  siteId: string; redemptionProgramRevisionRef: string; programRef: string; revision: bigint;
  productVersionRef: string; fulfillmentProgramRevisionRef: string;
  maxRedemptionsPerAccount: number; availabilityState: string; publishedAt: string;
}>;

export type CodeBatchRecord = Readonly<{
  siteId: string; batchRef: string; redemptionProgramRevisionRef: string;
  state: "draft" | "active" | "suspended" | "abandoned" | "revoked";
  approvalState: "pending" | "approved"; inventoryCount: number; createdByOperatorRef: string;
  startsAt: string | null; endsAt: string | null; createdAt: string; activatedAt: string | null;
  exportReceipt: Readonly<{ batchRef: string; exportCommandId: string;
    exportedToOperatorRef: string; codeCount: number; exportedAt: string }> | null;
}>;

export type EntitlementTemplateRevisionRecord = Readonly<{
  siteId: string; entitlementTemplateRevisionRef: string; templateRef: string; revision: bigint;
  capabilityKey: string; safeLabel: string; expiresAfterSeconds: bigint | null;
  revisionDigest: string; publishedAt: string;
}>;

export interface CommerceAdministrationReader {
  observeCatalog(permit: AdminQueryPermit): Promise<Readonly<{ watermark: string; observedAt: string }>>;
  getCreditProgramRevision(permit: AdminQueryPermit, siteId: string,
    revisionRef: string): Promise<CreditGrantProgramAdministrationRecord | null>;
  listCreditProgramRevisions(permit: AdminQueryPermit,
    input: Page): Promise<readonly CreditGrantProgramAdministrationRecord[]>;
  getEntitlementTemplateRevision(permit: AdminQueryPermit, siteId: string,
    revisionRef: string): Promise<EntitlementTemplateRevisionRecord | null>;
  listEntitlementTemplateRevisions(permit: AdminQueryPermit,
    input: Page): Promise<readonly EntitlementTemplateRevisionRecord[]>;
  getOffer(permit: AdminQueryPermit, siteId: string, productVersionRef: string): Promise<CommerceOfferRecord | null>;
  listOffers(permit: AdminQueryPermit, input: Page): Promise<readonly CommerceOfferRecord[]>;
  getRedemptionProgram(permit: AdminQueryPermit, siteId: string, revisionRef: string): Promise<RedemptionProgramRecord | null>;
  listRedemptionPrograms(permit: AdminQueryPermit, input: Page): Promise<readonly RedemptionProgramRecord[]>;
  getCodeBatch(permit: AdminQueryPermit, siteId: string, batchRef: string): Promise<CodeBatchRecord | null>;
  listCodeBatches(permit: AdminQueryPermit, input: Page): Promise<readonly CodeBatchRecord[]>;
}

type Page = Readonly<{ siteId: string; afterRef: string | null; watermark: string; limit: number }>;

interface OfferRow extends Record<string, unknown> {
  siteId: string; productRef: string; productKind: string; productVersionRef: string;
  revision: bigint | string; safeLabel: string; planVersionRef: string | null;
  fulfillmentProgramRevisionRef: string; outputs: unknown; legalTermRefs: unknown; publishedAt: Date | string;
}
interface ProgramRow extends Record<string, unknown> {
  siteId: string; redemptionProgramRevisionRef: string; programRef: string; revision: bigint | string;
  productVersionRef: string; fulfillmentProgramRevisionRef: string; maxRedemptionsPerAccount: number;
  availabilityState: string; publishedAt: Date | string;
}
interface BatchRow extends Record<string, unknown> {
  siteId: string; batchRef: string; redemptionProgramRevisionRef: string; state: string;
  approvalState: string; inventoryCount: number; createdByOperatorRef: string;
  startsAt: Date | string | null; endsAt: Date | string | null; createdAt: Date | string;
  activatedAt: Date | string | null; exportCommandId: string | null;
  exportedToOperatorRef: string | null; exportCodeCount: number | null; exportedAt: Date | string | null;
}
interface EntitlementTemplateRow extends Record<string, unknown> {
  siteId: string; entitlementTemplateRevisionRef: string; templateRef: string; revision: bigint | string;
  capabilityKey: string; safeLabel: string; expiresAfterSeconds: bigint | string | null;
  revisionDigest: string; publishedAt: Date | string;
}

export class PostgresCommerceAdministrationReader implements CommerceAdministrationReader {
  constructor(private readonly host: AdminQueryTransactionHost,
    private readonly creditPrograms: CreditGrantProgramAdministrationReader) {}

  observeCatalog(permit: AdminQueryPermit) {
    return this.host.adminQueryTransaction(permit, async (ownerTransaction) => {
      const rows = await resolvePlatformTransaction(ownerTransaction).query<Record<string, unknown> & {
        watermark: bigint | string; observedAt: Date | string;
      }>(`SELECT current_epoch::text AS watermark,clock_timestamp() AS "observedAt"
          FROM platform.commerce_catalog_epoch_authority WHERE singleton=TRUE`);
      const row = rows[0]; const watermark = row?.watermark?.toString() ?? "";
      const observedAt = new Date(row?.observedAt ?? Number.NaN);
      if (rows.length !== 1 || !validCatalogEpoch(watermark) || !Number.isFinite(observedAt.getTime())) {
        throw new Error("COMMERCE_ADMIN_WATERMARK_UNAVAILABLE");
      }
      return Object.freeze({ watermark, observedAt: observedAt.toISOString() });
    });
  }

  getCreditProgramRevision(permit: AdminQueryPermit, siteId: string, revisionRef: string) {
    return this.creditPrograms.getCreditProgramRevision(permit, siteId, revisionRef);
  }

  listCreditProgramRevisions(permit: AdminQueryPermit, input: Page) {
    return this.creditPrograms.listCreditProgramRevisions(permit, input);
  }

  getEntitlementTemplateRevision(permit: AdminQueryPermit, siteId: string, revisionRef: string) {
    requireSite(permit, siteId);
    return this.host.adminQueryTransaction(permit, async (ownerTransaction) => {
      const rows = await resolvePlatformTransaction(ownerTransaction).query<EntitlementTemplateRow>(
        `${entitlementTemplateProjection()} WHERE revision.site_ref=$1 AND revision.entitlement_template_revision_ref=$2 LIMIT 1`,
        [siteId, revisionRef],
      );
      return rows[0] === undefined ? null : entitlementTemplate(rows[0]);
    });
  }

  listEntitlementTemplateRevisions(permit: AdminQueryPermit, input: Page) {
    requireSite(permit, input.siteId); requirePage(input);
    return this.host.adminQueryTransaction(permit, async (ownerTransaction) => {
      const rows = await resolvePlatformTransaction(ownerTransaction).query<EntitlementTemplateRow>(
        `${entitlementTemplateProjection()} WHERE revision.site_ref=$1 AND revision.entitlement_template_revision_ref>$2
           AND revision.catalog_epoch<=$3::bigint
         ORDER BY revision.entitlement_template_revision_ref ASC LIMIT $4`,
        [input.siteId, input.afterRef ?? "", input.watermark, input.limit],
      );
      return Object.freeze(rows.map(entitlementTemplate));
    });
  }

  getOffer(permit: AdminQueryPermit, siteId: string, productVersionRef: string) {
    requireSite(permit, siteId);
    return this.host.adminQueryTransaction(permit, async (ownerTransaction) => {
      const rows = await resolvePlatformTransaction(ownerTransaction).query<OfferRow>(
        `${offerProjection()} WHERE version.site_ref=$1 AND version.product_version_ref=$2 LIMIT 1`,
        [siteId, productVersionRef],
      );
      return rows[0] === undefined ? null : offer(rows[0]);
    });
  }

  listOffers(permit: AdminQueryPermit, input: Page) {
    requireSite(permit, input.siteId); requirePage(input);
    return this.host.adminQueryTransaction(permit, async (ownerTransaction) => {
      const rows = await resolvePlatformTransaction(ownerTransaction).query<OfferRow>(
        `${offerProjection()} WHERE version.site_ref=$1 AND version.product_version_ref>$2
           AND version.catalog_epoch<=$3::bigint
         ORDER BY version.product_version_ref ASC LIMIT $4`,
        [input.siteId, input.afterRef ?? "", input.watermark, input.limit],
      );
      return Object.freeze(rows.map(offer));
    });
  }

  getRedemptionProgram(permit: AdminQueryPermit, siteId: string, revisionRef: string) {
    requireSite(permit, siteId);
    return this.host.adminQueryTransaction(permit, async (ownerTransaction) => {
      const rows = await resolvePlatformTransaction(ownerTransaction).query<ProgramRow>(
        `${programProjection()} WHERE revision.site_ref=$1 AND revision.redemption_program_revision_ref=$2 LIMIT 1`,
        [siteId, revisionRef],
      );
      return rows[0] === undefined ? null : program(rows[0]);
    });
  }

  listRedemptionPrograms(permit: AdminQueryPermit, input: Page) {
    requireSite(permit, input.siteId); requirePage(input);
    return this.host.adminQueryTransaction(permit, async (ownerTransaction) => {
      const rows = await resolvePlatformTransaction(ownerTransaction).query<ProgramRow>(
        `${programProjection()} WHERE revision.site_ref=$1 AND revision.redemption_program_revision_ref>$2
           AND revision.catalog_epoch<=$3::bigint
         ORDER BY revision.redemption_program_revision_ref ASC LIMIT $4`,
        [input.siteId, input.afterRef ?? "", input.watermark, input.limit],
      );
      return Object.freeze(rows.map(program));
    });
  }

  getCodeBatch(permit: AdminQueryPermit, siteId: string, batchRef: string) {
    requireSite(permit, siteId);
    return this.host.adminQueryTransaction(permit, async (ownerTransaction) => {
      const rows = await resolvePlatformTransaction(ownerTransaction).query<BatchRow>(
        `${batchProjection()} WHERE batch.site_ref=$1 AND batch.batch_ref=$2::uuid LIMIT 1`,
        [siteId, batchRef],
      );
      return rows[0] === undefined ? null : batch(rows[0]);
    });
  }

  listCodeBatches(permit: AdminQueryPermit, input: Page) {
    requireSite(permit, input.siteId); requirePage(input);
    return this.host.adminQueryTransaction(permit, async (ownerTransaction) => {
      const rows = await resolvePlatformTransaction(ownerTransaction).query<BatchRow>(
        `${batchProjection()} WHERE batch.site_ref=$1 AND batch.batch_ref>$2::uuid
           AND batch.catalog_epoch<=$3::bigint ORDER BY batch.batch_ref ASC LIMIT $4`,
        [input.siteId, input.afterRef ?? "00000000-0000-0000-0000-000000000000", input.watermark, input.limit],
      );
      return Object.freeze(rows.map(batch));
    });
  }
}

function entitlementTemplateProjection(): string {
  return `SELECT revision.site_ref AS "siteId",
    revision.entitlement_template_revision_ref AS "entitlementTemplateRevisionRef",
    revision.template_ref AS "templateRef",revision.revision,
    revision.capability_key AS "capabilityKey",revision.safe_label AS "safeLabel",
    revision.expires_after_seconds::text AS "expiresAfterSeconds",
    revision.revision_digest AS "revisionDigest",revision.published_at AS "publishedAt"
    FROM platform.commerce_entitlement_template_revision revision`;
}
function offerProjection(): string {
  return `SELECT version.site_ref AS "siteId",version.product_ref AS "productRef",
    product.kind AS "productKind",version.product_version_ref AS "productVersionRef",
    version.revision,version.safe_label AS "safeLabel",version.plan_version_ref AS "planVersionRef",
    version.fulfillment_program_revision_ref AS "fulfillmentProgramRevisionRef",
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'outputLineId',output.output_line_id,'ordinal',output.ordinal,'cardinality',output.cardinality,
      'outputKind',output.output_kind,'targetRevisionRef',COALESCE(output.plan_version_ref,
        output.entitlement_template_revision_ref,output.credit_program_revision_ref)
    ) ORDER BY output.ordinal) FROM platform.commerce_fulfillment_program_output output
      WHERE output.site_ref=version.site_ref AND
        output.fulfillment_program_revision_ref=version.fulfillment_program_revision_ref),'[]'::jsonb) AS outputs,
    version.legal_term_refs AS "legalTermRefs",version.published_at AS "publishedAt"
    FROM platform.commerce_catalog_product_version version
    JOIN platform.commerce_catalog_product product
      ON product.site_ref=version.site_ref AND product.product_ref=version.product_ref`;
}
function programProjection(): string {
  return `SELECT revision.site_ref AS "siteId",revision.redemption_program_revision_ref AS "redemptionProgramRevisionRef",
    revision.program_ref AS "programRef",revision.revision,revision.product_version_ref AS "productVersionRef",
    revision.fulfillment_program_revision_ref AS "fulfillmentProgramRevisionRef",
    revision.max_redemptions_per_account AS "maxRedemptionsPerAccount",
    availability.state AS "availabilityState",revision.published_at AS "publishedAt"
    FROM platform.commerce_redemption_program_revision revision
    JOIN platform.commerce_redemption_program_availability availability
      ON availability.site_ref=revision.site_ref AND
        availability.redemption_program_revision_ref=revision.redemption_program_revision_ref`;
}
function batchProjection(): string {
  return `SELECT batch.site_ref AS "siteId",batch.batch_ref::text AS "batchRef",
    batch.redemption_program_revision_ref AS "redemptionProgramRevisionRef",batch.state,
    CASE WHEN approval.batch_ref IS NULL THEN 'pending' ELSE 'approved' END AS "approvalState",
    batch.inventory_count AS "inventoryCount",batch.created_by_subject_ref AS "createdByOperatorRef",
    batch.starts_at AS "startsAt",batch.ends_at AS "endsAt",batch.created_at AS "createdAt",
    batch.activated_at AS "activatedAt",export.export_command_id AS "exportCommandId",
    export.exported_to_subject_ref AS "exportedToOperatorRef",export.code_count AS "exportCodeCount",
    export.exported_at AS "exportedAt"
    FROM platform.commerce_code_batch batch
    LEFT JOIN platform.commerce_code_batch_approval approval
      ON approval.site_ref=batch.site_ref AND approval.batch_ref=batch.batch_ref
    LEFT JOIN platform.commerce_code_secret_export export
      ON export.site_ref=batch.site_ref AND export.batch_ref=batch.batch_ref`;
}

function requireSite(permit: AdminQueryPermit, siteId: string): void {
  const allowed = permit.scope.kind === "global" ? null : permit.scope.kind === "site"
    ? permit.scope.siteRefs : permit.scope.resourceRefs;
  if (allowed !== null && !allowed.includes(siteId)) throw new Error("ADMIN_SITE_SCOPE_DENIED");
}
function validCatalogEpoch(value: string): boolean {
  return /^(?:0|[1-9][0-9]*)$/u.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n;
}
function requirePage(input: Page): void {
  if (!validCatalogEpoch(input.watermark) || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 201) {
    throw new Error("COMMERCE_ADMIN_PAGE_INVALID");
  }
}
function entitlementTemplate(row: EntitlementTemplateRow): EntitlementTemplateRevisionRecord {
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(row.capabilityKey)) {
    throw new Error("COMMERCE_ADMIN_ROW_CORRUPT");
  }
  return Object.freeze({ siteId: text(row.siteId),
    entitlementTemplateRevisionRef: text(row.entitlementTemplateRevisionRef), templateRef: text(row.templateRef),
    revision: positive(row.revision), capabilityKey: row.capabilityKey, safeLabel: safeLabel(row.safeLabel),
    expiresAfterSeconds: nullablePositive(row.expiresAfterSeconds),
    revisionDigest: digestText(row.revisionDigest), publishedAt: instant(row.publishedAt) });
}
function offer(row: OfferRow): CommerceOfferRecord {
  const kinds = ["free", "credit_pack", "subscription", "bundle"] as const;
  if (!kinds.includes(row.productKind as never)) throw new Error("COMMERCE_ADMIN_ROW_CORRUPT");
  const outputs = jsonArray(row.outputs).map((value) => {
    const item = record(value); const outputKinds = ["subscription_term", "entitlement_grant", "credit_grant"] as const;
    if (!outputKinds.includes(item.outputKind as never)) throw new Error("COMMERCE_ADMIN_ROW_CORRUPT");
    return Object.freeze({ outputLineId: text(item.outputLineId), ordinal: integer(item.ordinal),
      cardinality: integer(item.cardinality), outputKind: item.outputKind as typeof outputKinds[number],
      targetRevisionRef: text(item.targetRevisionRef) });
  });
  return Object.freeze({ siteId: text(row.siteId), productRef: text(row.productRef),
    productKind: row.productKind as typeof kinds[number], productVersionRef: text(row.productVersionRef),
    revision: positive(row.revision), safeLabel: safeLabel(row.safeLabel),
    planVersionRef: nullableText(row.planVersionRef),
    fulfillmentProgramRevisionRef: text(row.fulfillmentProgramRevisionRef), outputs: Object.freeze(outputs),
    legalTermRefs: stringArray(row.legalTermRefs), publishedAt: instant(row.publishedAt) });
}
function program(row: ProgramRow): RedemptionProgramRecord {
  return Object.freeze({ siteId: text(row.siteId), redemptionProgramRevisionRef: text(row.redemptionProgramRevisionRef),
    programRef: text(row.programRef), revision: positive(row.revision), productVersionRef: text(row.productVersionRef),
    fulfillmentProgramRevisionRef: text(row.fulfillmentProgramRevisionRef),
    maxRedemptionsPerAccount: integer(row.maxRedemptionsPerAccount), availabilityState: text(row.availabilityState),
    publishedAt: instant(row.publishedAt) });
}
function batch(row: BatchRow): CodeBatchRecord {
  const states = ["draft", "active", "suspended", "abandoned", "revoked"] as const;
  if (!states.includes(row.state as never) || !["pending", "approved"].includes(row.approvalState)) {
    throw new Error("COMMERCE_ADMIN_ROW_CORRUPT");
  }
  const exportReceipt = row.exportCommandId === null ? null : Object.freeze({ batchRef: text(row.batchRef),
    exportCommandId: row.exportCommandId, exportedToOperatorRef: text(row.exportedToOperatorRef),
    codeCount: integer(row.exportCodeCount), exportedAt: instant(row.exportedAt) });
  return Object.freeze({ siteId: text(row.siteId), batchRef: text(row.batchRef),
    redemptionProgramRevisionRef: text(row.redemptionProgramRevisionRef), state: row.state as typeof states[number],
    approvalState: row.approvalState as "pending" | "approved", inventoryCount: integer(row.inventoryCount),
    createdByOperatorRef: text(row.createdByOperatorRef), startsAt: nullableInstant(row.startsAt),
    endsAt: nullableInstant(row.endsAt), createdAt: instant(row.createdAt),
    activatedAt: nullableInstant(row.activatedAt), exportReceipt });
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("COMMERCE_ADMIN_ROW_CORRUPT");
  return value as Record<string, unknown>;
}
function jsonArray(value: unknown): readonly unknown[] {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(parsed)) throw new Error("COMMERCE_ADMIN_ROW_CORRUPT"); return parsed;
}
function text(value: unknown): string { if (typeof value !== "string" || value.length < 1) throw new Error("COMMERCE_ADMIN_ROW_CORRUPT"); return value; }
function nullableText(value: unknown): string | null { return value === null ? null : text(value); }
function integer(value: unknown): number { if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error("COMMERCE_ADMIN_ROW_CORRUPT"); return value; }
function positive(value: unknown): bigint { const result = typeof value === "bigint" ? value : typeof value === "string" ? BigInt(value) : 0n; if (result < 1n || result > 9_223_372_036_854_775_807n) throw new Error("COMMERCE_ADMIN_ROW_CORRUPT"); return result; }
function nullablePositive(value: unknown): bigint | null { return value === null ? null : positive(value); }
function instant(value: unknown): string { const result = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null; if (result === null || !Number.isFinite(result.getTime())) throw new Error("COMMERCE_ADMIN_ROW_CORRUPT"); return result.toISOString(); }
function nullableInstant(value: unknown): string | null { return value === null ? null : instant(value); }
function stringArray(value: unknown): readonly string[] { if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("COMMERCE_ADMIN_ROW_CORRUPT"); return Object.freeze([...value] as string[]); }
function digestText(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new Error("COMMERCE_ADMIN_ROW_CORRUPT");
  return value;
}
function safeLabel(value: unknown): string {
  const label = text(value);
  if ([...label].length > 160 || label.normalize("NFC") !== label || label.trim() !== label ||
      /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(label)) throw new Error("COMMERCE_ADMIN_ROW_CORRUPT");
  return label;
}
