import { createHash } from "node:crypto";
import type {
  CreditProgramWindowRepositoryPort,
  DueCreditProgramEnrollment,
} from "../../application/contracts/credit-program-window-repository.js";
import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";
import type { CreditGrantScopePolicy } from "../../../credit/application/contracts/grant-issuance.js";

type EnrollmentRow = Record<string, unknown> & {
  enrollmentRef: string; siteId: string; billingAccountId: string;
  creditProgramRevisionRef: string; creditProgramRevision: bigint | string;
  creditProgramRevisionDigest: string; outputLineId: string; outputOrdinal: number; occurrence: number;
  bucketClass: "daily" | "period"; windowKind: "daily" | "period"; calendarZone: string;
  windowAnchor: string; expiresAfterSeconds: bigint | string | null; effectiveAt: Date | string;
  endsAt: Date | string; unit: string; amount: string; liabilityMerchantAccountId: string;
  burnPriority: number; scopePolicy: CreditGrantScopePolicy; acquiredAt: Date | string;
};

type WindowRow = Record<string, unknown> & { windowStartsAt: Date | string; windowEndsAt: Date | string };

export class PostgresCreditProgramWindowRepository implements CreditProgramWindowRepositoryPort {
  async claimDue(
    transaction: Parameters<CreditProgramWindowRepositoryPort["claimDue"]>[0],
    limit: number,
  ): ReturnType<CreditProgramWindowRepositoryPort["claimDue"]> {
    const sql = resolvePlatformTransaction(transaction);
    const rows = await sql.query<EnrollmentRow>(
      `WITH effect AS MATERIALIZED (SELECT clock_timestamp() AS acquired_at)
       SELECT enrollment.enrollment_ref AS "enrollmentRef",enrollment.site_ref AS "siteId",
              enrollment.billing_account_ref AS "billingAccountId",
              enrollment.credit_program_revision_ref AS "creditProgramRevisionRef",
              enrollment.credit_program_revision AS "creditProgramRevision",
              enrollment.credit_program_revision_digest AS "creditProgramRevisionDigest",
              enrollment.output_line_id AS "outputLineId",enrollment.output_ordinal AS "outputOrdinal",
              enrollment.occurrence,program.ux_bucket_class AS "bucketClass",
              program.window_kind AS "windowKind",program.calendar_zone AS "calendarZone",
              program.window_anchor AS "windowAnchor",
              program.expires_after_seconds AS "expiresAfterSeconds",
              enrollment.effective_at AS "effectiveAt",enrollment.ends_at AS "endsAt",
              program.unit,program.amount::text AS amount,
              program.liability_merchant_account_ref AS "liabilityMerchantAccountId",
              program.burn_priority AS "burnPriority",program.scope_policy AS "scopePolicy",
              effect.acquired_at AS "acquiredAt"
       FROM effect
       JOIN platform.commerce_credit_program_enrollment enrollment
         ON enrollment.effective_at<=effect.acquired_at
        AND enrollment.ends_at>effect.acquired_at
       JOIN platform.credit_grant_program_revision program
         ON program.credit_program_revision_ref=enrollment.credit_program_revision_ref
        AND program.site_ref=enrollment.site_ref AND program.revision=enrollment.credit_program_revision
        AND program.revision_digest=enrollment.credit_program_revision_digest
       WHERE NOT EXISTS (
         SELECT 1 FROM platform.commerce_credit_program_enrollment_revocation revocation
         WHERE revocation.site_ref=enrollment.site_ref AND revocation.enrollment_ref=enrollment.enrollment_ref
           AND revocation.effective_at<=effect.acquired_at
       )
       ORDER BY enrollment.site_ref,enrollment.enrollment_ref
       FOR UPDATE OF enrollment SKIP LOCKED
       LIMIT $1`,
      [limit],
    );
    const result: DueCreditProgramEnrollment[] = [];
    for (const row of rows) {
      const window = await resolveWindow(sql, row);
      const startsAt = instant(window.windowStartsAt);
      const endsAt = instant(window.windowEndsAt);
      const acquiredAt = instant(row.acquiredAt);
      if (Date.parse(startsAt) > Date.parse(acquiredAt)) {
        throw new Error("CREDIT_WINDOW_OWNER_BOUNDARY_INVALID");
      }
      // A period grant may intentionally expire before the SubscriptionTerm. That is one closed
      // period, not a signal to mint another grant or poison the entire worker batch.
      if (Date.parse(endsAt) <= Date.parse(acquiredAt)) continue;
      const windowKey = createHash("sha256").update(
        `${row.enrollmentRef}\0${row.bucketClass}\0${startsAt}\0${endsAt}`, "utf8",
      ).digest("hex");
      const prior = await sql.query<{ present: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM platform.credit_program_window_acquisition
           WHERE site_ref=$1 AND enrollment_ref=$2::uuid AND window_key=$3
         ) AS present`,
        [row.siteId, row.enrollmentRef, windowKey],
      );
      if (prior.length !== 1) throw new Error("CREDIT_WINDOW_ACQUISITION_AUTHORITY_INVALID");
      if (prior[0]!.present) continue;
      result.push(Object.freeze({
        enrollmentRef: row.enrollmentRef, siteId: row.siteId, billingAccountId: row.billingAccountId,
        creditProgramRevisionRef: row.creditProgramRevisionRef,
        creditProgramRevision: BigInt(row.creditProgramRevision),
        creditProgramRevisionDigest: row.creditProgramRevisionDigest,
        outputLineId: row.outputLineId, outputOrdinal: row.outputOrdinal, occurrence: row.occurrence,
        bucketClass: row.bucketClass, unit: row.unit, amount: row.amount,
        liabilityMerchantAccountId: row.liabilityMerchantAccountId, burnPriority: row.burnPriority,
        scopePolicy: row.scopePolicy, windowKey, windowStartsAt: startsAt, windowEndsAt: endsAt, acquiredAt,
      }));
    }
    return Object.freeze(result);
  }

  async recordAcquisition(
    transaction: Parameters<CreditProgramWindowRepositoryPort["recordAcquisition"]>[0],
    input: Parameters<CreditProgramWindowRepositoryPort["recordAcquisition"]>[1],
  ): Promise<void> {
    if (input.receipt.outputLineId !== input.enrollment.outputLineId ||
        input.receipt.outputOrdinal !== input.enrollment.outputOrdinal ||
        input.receipt.occurrence !== input.enrollment.occurrence) {
      throw new Error("CREDIT_WINDOW_GRANT_RECEIPT_INVALID");
    }
    const changed = await resolvePlatformTransaction(transaction).execute(
      `INSERT INTO platform.credit_program_window_acquisition
       (acquisition_ref,site_ref,enrollment_ref,window_key,window_starts_at,window_ends_at,
        credit_grant_ref,acquired_at)
       VALUES ($1::uuid,$2,$3::uuid,$4,$5::timestamptz,$6::timestamptz,$7::uuid,$8::timestamptz)`,
      [input.acquisitionRef, input.enrollment.siteId, input.enrollment.enrollmentRef,
        input.enrollment.windowKey, input.enrollment.windowStartsAt, input.enrollment.windowEndsAt,
        input.receipt.creditGrantRef, input.enrollment.acquiredAt],
    );
    if (changed !== 1) throw new Error("CREDIT_WINDOW_ACQUISITION_PERSIST_FAILED");
  }
}

async function resolveWindow(
  sql: ReturnType<typeof resolvePlatformTransaction>,
  row: EnrollmentRow,
): Promise<WindowRow> {
  if (row.bucketClass === "period") {
    const result = await sql.query<WindowRow>(
      `SELECT $1::timestamptz AS "windowStartsAt",
              LEAST($2::timestamptz,
                CASE WHEN $3::bigint IS NULL THEN $2::timestamptz
                     ELSE $1::timestamptz + make_interval(secs => $3::bigint) END) AS "windowEndsAt"`,
      [row.effectiveAt, row.endsAt, row.expiresAfterSeconds],
    );
    if (result.length !== 1) throw new Error("CREDIT_WINDOW_OWNER_BOUNDARY_INVALID");
    return result[0]!;
  }
  const localReset = row.windowAnchor.slice("daily@".length);
  const result = await sql.query<WindowRow>(
    `WITH local_clock AS (
       SELECT $1::timestamptz AS acquired_at,$1::timestamptz AT TIME ZONE $2 AS local_now,
              date_trunc('day',$1::timestamptz AT TIME ZONE $2)+$3::time AS anchor_today
     ), local_window AS (
       SELECT CASE WHEN anchor_today<=local_now THEN anchor_today ELSE anchor_today-interval '1 day' END AS starts
       FROM local_clock
     )
     SELECT GREATEST($4::timestamptz,starts AT TIME ZONE $2) AS "windowStartsAt",
            LEAST($5::timestamptz,(starts+interval '1 day') AT TIME ZONE $2) AS "windowEndsAt"
     FROM local_window`,
    [row.acquiredAt, row.calendarZone, localReset, row.effectiveAt, row.endsAt],
  );
  if (result.length !== 1) throw new Error("CREDIT_WINDOW_OWNER_BOUNDARY_INVALID");
  return result[0]!;
}

function instant(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("CREDIT_WINDOW_TIMESTAMP_INVALID");
  return parsed.toISOString();
}
