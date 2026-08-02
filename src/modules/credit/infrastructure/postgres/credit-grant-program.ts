import type { CreditGrantProgramPort, CreditGrantProgramRevision, CreditGrantProgramTarget } from
  "../../application/contracts/grant-program.js";
import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";

type ProgramRow = Record<string, unknown> & {
  revisionRef: string; revision: bigint | string; revisionDigest: string;
  bucketClass: CreditGrantProgramRevision["bucketClass"]; unit: string; amount: string;
  expiresAfterSeconds: bigint | string | null; liabilityMerchantAccountId: string; burnPriority: number;
  windowKind: "none" | "daily" | "period"; calendarZone: string | null; windowAnchor: string | null;
  scopePolicy: CreditGrantProgramRevision["scopePolicy"];
};

export class PostgresCreditGrantProgram implements CreditGrantProgramPort {
  async resolveTargets(transaction: Parameters<CreditGrantProgramPort["resolveTargets"]>[0],
    input: Parameters<CreditGrantProgramPort["resolveTargets"]>[1]): Promise<readonly CreditGrantProgramRevision[]> {
    bounded(input.siteId, 256);
    validateTargets(input.targets);
    return this.#resolve(transaction, input.siteId, input.targets.map((target) => ({ ref: target.revisionRef,
      revision: target.revision.toString(), digest: target.revisionDigest })), true);
  }

  async resolveRefs(transaction: Parameters<CreditGrantProgramPort["resolveRefs"]>[0],
    input: Parameters<CreditGrantProgramPort["resolveRefs"]>[1]): Promise<readonly CreditGrantProgramRevision[]> {
    bounded(input.siteId, 256);
    if (input.revisionRefs.length < 1 || input.revisionRefs.length > 32 ||
        new Set(input.revisionRefs).size !== input.revisionRefs.length ||
        input.revisionRefs.some((ref) => !boundedValue(ref, 256))) throw new Error("CREDIT_PROGRAM_TARGETS_INVALID");
    return this.#resolve(transaction, input.siteId, input.revisionRefs.map((ref) => ({ ref })), false);
  }

  async publishRevision(transaction: Parameters<CreditGrantProgramPort["publishRevision"]>[0],
    input: Parameters<CreditGrantProgramPort["publishRevision"]>[1]): Promise<void> {
    const changed = await resolvePlatformTransaction(transaction).execute(
      `INSERT INTO platform.credit_grant_program_revision
       (credit_program_revision_ref,site_ref,program_ref,revision,ux_bucket_class,unit,amount,burn_priority,
        scope_policy,liability_merchant_account_ref,window_kind,rollover_policy,calendar_zone,window_anchor,
        expires_after_seconds,revision_digest,catalog_epoch,published_at)
       VALUES ($1,$2,$3,$4::bigint,$5,$6,$7::numeric,$8,$9::jsonb,$10,$11,$12,$13,$14,$15::bigint,$16,$17::bigint,$18::timestamptz)`,
      [input.revisionRef, input.siteId, input.programRef, input.revision.toString(), input.bucketClass, input.unit,
        input.amount, input.burnPriority, JSON.stringify(input.scopePolicy), input.liabilityMerchantAccountId,
        input.windowKind, input.rolloverPolicy, input.calendarZone, input.windowAnchor,
        input.expiresAfterSeconds?.toString() ?? null, input.revisionDigest, input.catalogEpoch.toString(), input.publishedAt],
    );
    if (changed !== 1) throw new Error("CREDIT_PROGRAM_PERSIST_FAILED");
  }

  async #resolve(transaction: Parameters<CreditGrantProgramPort["resolveTargets"]>[0], siteId: string,
    targets: readonly Record<string, string>[], exact: boolean): Promise<readonly CreditGrantProgramRevision[]> {
    const rows = await resolvePlatformTransaction(transaction).query<ProgramRow>(
      `SELECT revision.credit_program_revision_ref AS "revisionRef",revision.revision,
              revision.revision_digest AS "revisionDigest",revision.ux_bucket_class AS "bucketClass",
              revision.unit,revision.amount::text AS amount,revision.expires_after_seconds AS "expiresAfterSeconds",
              revision.window_kind AS "windowKind",revision.calendar_zone AS "calendarZone",
              revision.window_anchor AS "windowAnchor",
              revision.liability_merchant_account_ref AS "liabilityMerchantAccountId",
              revision.burn_priority AS "burnPriority",revision.scope_policy AS "scopePolicy"
       FROM jsonb_to_recordset($2::jsonb) AS target(ref TEXT,revision TEXT,digest TEXT)
       JOIN platform.credit_grant_program_revision revision
         ON revision.site_ref=$1 AND revision.credit_program_revision_ref=target.ref
        AND (NOT $3::boolean OR (revision.revision=target.revision::bigint AND revision.revision_digest=target.digest))
       ORDER BY target.ref`,
      [siteId, JSON.stringify(targets), exact],
    );
    if (rows.length !== targets.length) throw new Error("CREDIT_PROGRAM_TARGET_MISMATCH");
    return Object.freeze(rows.map(program));
  }
}

function validateTargets(targets: readonly CreditGrantProgramTarget[]): void {
  if (targets.length < 1 || targets.length > 32 || new Set(targets.map((target) => target.revisionRef)).size !== targets.length ||
      targets.some((target) => !boundedValue(target.revisionRef, 256) || target.revision < 1n ||
        target.revision > 9_223_372_036_854_775_807n || !/^[a-f0-9]{64}$/u.test(target.revisionDigest))) {
    throw new Error("CREDIT_PROGRAM_TARGETS_INVALID");
  }
}

function program(row: ProgramRow): CreditGrantProgramRevision {
  const revision = integer(row.revision);
  const expiresAfterSeconds = row.expiresAfterSeconds === null ? null : integer(row.expiresAfterSeconds);
  if (!boundedValue(row.revisionRef, 256) || !/^[a-f0-9]{64}$/u.test(row.revisionDigest) ||
      !(["daily", "period", "permanent"] as const).includes(row.bucketClass) || !boundedValue(row.unit, 64) ||
      !/^[1-9][0-9]{0,37}$/u.test(row.amount) || !boundedValue(row.liabilityMerchantAccountId, 256) ||
      !Number.isInteger(row.burnPriority) || row.burnPriority < -2_147_483_648 || row.burnPriority > 2_147_483_647 ||
      (row.bucketClass === "permanent") !== (row.windowKind === "none") ||
      (row.bucketClass === "daily" && (row.windowKind !== "daily" || row.calendarZone === null ||
        !/^daily@(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$/u.test(row.windowAnchor ?? ""))) ||
      (row.bucketClass === "period" && (row.windowKind !== "period" || row.calendarZone === null ||
        row.windowAnchor !== "subscription-term-start")) ||
      (row.bucketClass === "permanent" && (row.calendarZone !== null || row.windowAnchor !== null ||
        expiresAfterSeconds !== null))) {
    throw new Error("CREDIT_PROGRAM_SNAPSHOT_INVALID");
  }
  const scopePolicy = row.scopePolicy;
  if (scopePolicy === null || typeof scopePolicy !== "object" || scopePolicy.version !== 1 ||
      typeof scopePolicy.allowUnattributedAgent !== "boolean") throw new Error("CREDIT_PROGRAM_SNAPSHOT_INVALID");
  const surfaceRefs = policyRefs(scopePolicy.surfaceRefs, true, /^[a-z0-9][a-z0-9._:-]{0,255}$/u);
  const capabilityKeys = policyRefs(scopePolicy.capabilityKeys, true, /^[a-z0-9][a-z0-9._:-]{0,255}$/u);
  const agentRefs = policyRefs(scopePolicy.agentRefs, false, /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u);
  if (!scopePolicy.allowUnattributedAgent && agentRefs.length === 0) throw new Error("CREDIT_PROGRAM_SNAPSHOT_INVALID");
  return Object.freeze({ revisionRef: row.revisionRef, revision, revisionDigest: row.revisionDigest,
    bucketClass: row.bucketClass, unit: row.unit, amount: row.amount, expiresAfterSeconds,
    windowKind: row.windowKind, calendarZone: row.calendarZone, windowAnchor: row.windowAnchor,
    liabilityMerchantAccountId: row.liabilityMerchantAccountId, burnPriority: row.burnPriority,
    scopePolicy: Object.freeze({ version: 1, surfaceRefs, capabilityKeys, agentRefs,
      allowUnattributedAgent: scopePolicy.allowUnattributedAgent }) });
}

function policyRefs(value: unknown, required: boolean, pattern: RegExp): readonly string[] {
  if (!Array.isArray(value) || (required && value.length < 1) || value.length > 256 ||
      value.some((item) => typeof item !== "string" || !pattern.test(item)) ||
      new Set(value).size !== value.length) throw new Error("CREDIT_PROGRAM_SNAPSHOT_INVALID");
  return Object.freeze([...value] as string[]);
}

function integer(value: bigint | string): bigint {
  const result = BigInt(value);
  if (result < 1n || result > 9_223_372_036_854_775_807n) throw new Error("CREDIT_PROGRAM_SNAPSHOT_INVALID");
  return result;
}

function bounded(value: string, maximum: number): void {
  if (!boundedValue(value, maximum)) throw new Error("CREDIT_PROGRAM_TARGETS_INVALID");
}

function boundedValue(value: string, maximum: number): boolean {
  return value.length >= 1 && value.length <= maximum &&
    ![...value].some((character) => character.codePointAt(0)! < 32);
}
