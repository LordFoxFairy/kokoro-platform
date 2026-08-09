import type { AdminQueryPermit } from "../../../admin/interfaces/connect/admin-query-service.js";
import type { AdminSiteQueryTransactionHost } from
  "../../../admin/infrastructure/postgres/admin-query-reader.js";
import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";
import type {
  CreditGrantProgramAdministrationPage,
  CreditGrantProgramAdministrationReader,
  CreditGrantProgramAdministrationRecord,
} from "../../application/contracts/credit-program-administration-reader.js";

interface Row extends Record<string, unknown> {
  siteId: string; creditProgramRevisionRef: string; programRef: string; revision: bigint | string;
  uxBucketClass: string; unit: string; amount: string; burnPriority: number; scopePolicy: unknown;
  liabilityMerchantAccountRef: string; windowKind: string; rolloverPolicy: string;
  calendarZone: string | null; windowAnchor: string | null; expiresAfterSeconds: bigint | string | null;
  revisionDigest: string; publishedAt: Date | string;
}

export class PostgresCreditGrantProgramAdministrationReader implements CreditGrantProgramAdministrationReader {
  constructor(private readonly host: AdminSiteQueryTransactionHost) {}

  getCreditProgramRevision(permit: AdminQueryPermit, siteId: string, revisionRef: string) {
    requireSite(permit, siteId);
    return this.host.adminSiteQueryTransaction(permit, siteId, async (transaction) => {
      const rows = await resolvePlatformTransaction(transaction).query<Row>(
        `${projection()} WHERE revision.site_ref=$1 AND revision.credit_program_revision_ref=$2 LIMIT 1`,
        [siteId, revisionRef],
      );
      return rows[0] === undefined ? null : record(rows[0]);
    });
  }

  listCreditProgramRevisions(permit: AdminQueryPermit, input: CreditGrantProgramAdministrationPage) {
    requireSite(permit, input.siteId);
    requirePage(input);
    return this.host.adminSiteQueryTransaction(permit, input.siteId, async (transaction) => {
      const rows = await resolvePlatformTransaction(transaction).query<Row>(
        `${projection()} WHERE revision.site_ref=$1 AND revision.credit_program_revision_ref>$2
           AND revision.catalog_epoch<=$3::bigint
         ORDER BY revision.credit_program_revision_ref ASC LIMIT $4`,
        [input.siteId, input.afterRef ?? "", input.watermark, input.limit],
      );
      return Object.freeze(rows.map(record));
    });
  }
}

function projection(): string {
  return `SELECT revision.site_ref AS "siteId",
    revision.credit_program_revision_ref AS "creditProgramRevisionRef",
    revision.program_ref AS "programRef",revision.revision,
    revision.ux_bucket_class AS "uxBucketClass",revision.unit,revision.amount::text AS amount,
    revision.burn_priority AS "burnPriority",revision.scope_policy AS "scopePolicy",
    revision.liability_merchant_account_ref AS "liabilityMerchantAccountRef",
    revision.window_kind AS "windowKind",revision.rollover_policy AS "rolloverPolicy",
    revision.calendar_zone AS "calendarZone",revision.window_anchor AS "windowAnchor",
    revision.expires_after_seconds::text AS "expiresAfterSeconds",
    revision.revision_digest AS "revisionDigest",revision.published_at AS "publishedAt"
    FROM platform.commerce_credit_program_revision revision`;
}

function record(row: Row): CreditGrantProgramAdministrationRecord {
  const buckets = ["daily", "period", "permanent"] as const;
  const windows = ["none", "daily", "period"] as const;
  if (!buckets.includes(row.uxBucketClass as never) || !windows.includes(row.windowKind as never) ||
      row.rolloverPolicy !== "none" || !/^[1-9][0-9]{0,37}$/u.test(row.amount) ||
      !Number.isInteger(row.burnPriority)) throw new Error("CREDIT_ADMIN_ROW_CORRUPT");
  const expiresAfterSeconds = nullablePositive(row.expiresAfterSeconds);
  const calendarZone = nullableText(row.calendarZone);
  const windowAnchor = nullableText(row.windowAnchor);
  if ((row.uxBucketClass === "permanent" && (row.windowKind !== "none" || calendarZone !== null ||
      windowAnchor !== null || expiresAfterSeconds !== null)) ||
      (row.uxBucketClass === "daily" && (row.windowKind !== "daily" || calendarZone === null ||
        expiresAfterSeconds !== null ||
        !/^daily@(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$/u.test(windowAnchor ?? ""))) ||
      (row.uxBucketClass === "period" && (row.windowKind !== "period" || calendarZone === null ||
        windowAnchor !== "subscription-term-start"))) {
    throw new Error("CREDIT_ADMIN_ROW_CORRUPT");
  }
  return Object.freeze({ siteId: text(row.siteId), creditProgramRevisionRef: text(row.creditProgramRevisionRef),
    programRef: text(row.programRef), revision: positive(row.revision),
    uxBucketClass: row.uxBucketClass as typeof buckets[number], unit: text(row.unit), amount: row.amount,
    burnPriority: row.burnPriority, scopePolicy: scopePolicy(row.scopePolicy),
    liabilityMerchantAccountRef: text(row.liabilityMerchantAccountRef),
    windowKind: row.windowKind as typeof windows[number], rolloverPolicy: "none", calendarZone,
    windowAnchor, expiresAfterSeconds, revisionDigest: digest(row.revisionDigest),
    publishedAt: instant(row.publishedAt) });
}

function requireSite(permit: AdminQueryPermit, siteId: string): void {
  const allowed = permit.scope.kind === "global" ? null : permit.scope.kind === "site"
    ? permit.scope.siteRefs : permit.scope.resourceRefs;
  if (allowed !== null && !allowed.includes(siteId)) throw new Error("ADMIN_SITE_SCOPE_DENIED");
}
function requirePage(input: CreditGrantProgramAdministrationPage): void {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(input.watermark) || BigInt(input.watermark) > 9_223_372_036_854_775_807n ||
      !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 201) throw new Error("CREDIT_ADMIN_PAGE_INVALID");
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.length < 1) throw new Error("CREDIT_ADMIN_ROW_CORRUPT");
  return value;
}
function nullableText(value: unknown): string | null { return value === null ? null : text(value); }
function positive(value: unknown): bigint {
  const result = typeof value === "bigint" ? value : typeof value === "string" ? BigInt(value) : 0n;
  if (result < 1n || result > 9_223_372_036_854_775_807n) throw new Error("CREDIT_ADMIN_ROW_CORRUPT");
  return result;
}
function nullablePositive(value: unknown): bigint | null { return value === null ? null : positive(value); }
function instant(value: unknown): string {
  const result = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (result === null || !Number.isFinite(result.getTime())) throw new Error("CREDIT_ADMIN_ROW_CORRUPT");
  return result.toISOString();
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new Error("CREDIT_ADMIN_ROW_CORRUPT");
  return value;
}
function scopePolicy(value: unknown): CreditGrantProgramAdministrationRecord["scopePolicy"] {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("CREDIT_ADMIN_ROW_CORRUPT");
  const item = parsed as Record<string, unknown>;
  if (Object.keys(item).sort().join(",") !== "agentRefs,allowUnattributedAgent,capabilityKeys,surfaceRefs,version" ||
      item.version !== 1 || typeof item.allowUnattributedAgent !== "boolean") throw new Error("CREDIT_ADMIN_ROW_CORRUPT");
  return Object.freeze({ version: 1, surfaceRefs: policyArray(item.surfaceRefs, true),
    capabilityKeys: policyArray(item.capabilityKeys, true), agentRefs: policyArray(item.agentRefs, false),
    allowUnattributedAgent: item.allowUnattributedAgent });
}
function policyArray(value: unknown, required: boolean): readonly string[] {
  if (!Array.isArray(value) || (required && value.length < 1) || value.length > 256 ||
      value.some((item) => typeof item !== "string" || item.length < 1 || item.length > 256) ||
      new Set(value).size !== value.length) throw new Error("CREDIT_ADMIN_ROW_CORRUPT");
  return Object.freeze([...value] as string[]);
}
