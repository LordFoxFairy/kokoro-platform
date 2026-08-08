import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";
import type {
  SiteDangerousOperation,
  SiteEffectApprovalAdministration,
} from "../../application/contracts/site-effect-approval.js";

interface ApprovalIdentity {
  readonly approvalRef: string;
  readonly siteRef: string;
  readonly environment: string;
  readonly region: string;
  readonly operation: SiteDangerousOperation;
  readonly effectDigest: string;
}

export class PostgresSiteEffectApprovalAuthority implements SiteEffectApprovalAdministration {
  async request(
    transaction: PlatformTransaction,
    input: ApprovalIdentity & Readonly<{
      reason: string; commandId: string; idempotencyKey: string; requestDigest: string;
      makerSubjectRef: string; requestedAt: string; expiresAt: string;
    }>,
  ): Promise<Readonly<{
    approvalRef: string; state: "pending" | "approved" | "consumed";
    recordedAt: string; expiresAt: string;
  }>> {
    verifyIdentity(input);
    verifyReason(input.reason);
    identifier(input.commandId, "SITE_APPROVAL_COMMAND_ID_INVALID");
    identifier(input.idempotencyKey, "SITE_APPROVAL_IDEMPOTENCY_KEY_INVALID");
    if (!/^[a-f0-9]{64}$/u.test(input.requestDigest)) {
      throw new Error("SITE_APPROVAL_REQUEST_DIGEST_INVALID");
    }
    identifier(input.makerSubjectRef, "SITE_APPROVAL_MAKER_INVALID");
    instant(input.requestedAt, "SITE_APPROVAL_TIME_INVALID");
    instant(input.expiresAt, "SITE_APPROVAL_TIME_INVALID");
    if (Date.parse(input.expiresAt) <= Date.parse(input.requestedAt)) {
      throw new Error("SITE_APPROVAL_EXPIRY_INVALID");
    }
    const sql = resolvePlatformTransaction(transaction);
    const inserted = await sql.execute(
      `INSERT INTO platform.site_effect_approval
       (approval_ref,site_ref,environment,region,operation,effect_digest,reason,command_id,
        idempotency_key,request_digest,state,maker_subject_ref,requested_at,expires_at)
       VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11,$12::timestamptz,$13::timestamptz)
       ON CONFLICT (approval_ref) DO NOTHING`,
      [input.approvalRef, input.siteRef, input.environment, input.region, input.operation,
        input.effectDigest, input.reason, input.commandId, input.idempotencyKey,
        input.requestDigest, input.makerSubjectRef, input.requestedAt, input.expiresAt],
    );
    if (inserted === 1) return Object.freeze({ approvalRef: input.approvalRef,
      state: "pending", recordedAt: input.requestedAt, expiresAt: input.expiresAt });
    const existing = await sql.query<{
      exact: boolean; state: unknown; recordedAt: unknown; expiresAt: unknown;
    }>(
      `SELECT site_ref=$2 AND environment=$3 AND region=$4 AND operation=$5
              AND effect_digest=$6 AND reason=$7 AND command_id=$8 AND idempotency_key=$9
              AND request_digest=$10 AND maker_subject_ref=$11 AS exact,state,
              requested_at AS "recordedAt",
              expires_at AS "expiresAt"
       FROM platform.site_effect_approval WHERE approval_ref=$1::uuid`,
      [input.approvalRef, input.siteRef, input.environment, input.region, input.operation,
        input.effectDigest, input.reason, input.commandId, input.idempotencyKey,
        input.requestDigest, input.makerSubjectRef],
    );
    const row = existing[0];
    if (row?.exact !== true) throw new Error("SITE_EFFECT_APPROVAL_REQUEST_CONFLICT");
    return Object.freeze({ approvalRef: input.approvalRef,
      state: approvalState(row.state), recordedAt: instantValue(row.recordedAt),
      expiresAt: instantValue(row.expiresAt) });
  }

  async approve(
    transaction: PlatformTransaction,
    input: ApprovalIdentity & Readonly<{ checkerSubjectRef: string; decidedAt: string }>,
  ): Promise<void> {
    verifyIdentity(input);
    identifier(input.checkerSubjectRef, "SITE_APPROVAL_CHECKER_INVALID");
    instant(input.decidedAt, "SITE_APPROVAL_TIME_INVALID");
    const changed = await resolvePlatformTransaction(transaction).execute(
      `UPDATE platform.site_effect_approval
       SET state='approved',checker_subject_ref=$8,decided_at=$7::timestamptz,updated_at=now()
       WHERE approval_ref=$1::uuid AND site_ref=$2 AND environment=$3 AND region=$4
         AND operation=$5 AND effect_digest=$6 AND state='pending'
         AND expires_at>$7::timestamptz AND maker_subject_ref<>$8`,
      [input.approvalRef, input.siteRef, input.environment, input.region, input.operation,
        input.effectDigest, input.decidedAt, input.checkerSubjectRef],
    );
    if (changed === 1) return;
    const existing = await resolvePlatformTransaction(transaction).query<{ exact: boolean }>(
      `SELECT site_ref=$2 AND environment=$3 AND region=$4 AND operation=$5
              AND effect_digest=$6 AND checker_subject_ref=$7
              AND state IN ('approved','consumed') AS exact
       FROM platform.site_effect_approval WHERE approval_ref=$1::uuid`,
      [input.approvalRef, input.siteRef, input.environment, input.region, input.operation,
        input.effectDigest, input.checkerSubjectRef],
    );
    if (existing[0]?.exact !== true) throw new Error("SITE_EFFECT_APPROVAL_DECISION_CONFLICT");
  }

  async consume(
    transaction: PlatformTransaction,
    input: ApprovalIdentity,
    context: VerifiedRequestSecurityContext,
  ): Promise<void> {
    verifyIdentity(input);
    if (context.actor.kind !== "operator") throw new Error("SITE_APPROVAL_CHECKER_REQUIRED");
    if (input.environment !== context.environment || input.region !== context.region) {
      throw new Error("SITE_APPROVAL_AXIS_MISMATCH");
    }
    const changed = await resolvePlatformTransaction(transaction).execute(
      `UPDATE platform.site_effect_approval
       SET state='consumed',consumed_request_id=$7,consumed_at=now(),updated_at=now()
       WHERE approval_ref=$1::uuid AND site_ref=$2 AND environment=$3 AND region=$4
         AND operation=$5 AND effect_digest=$6 AND state='approved' AND expires_at>now()
         AND checker_subject_ref=$8 AND maker_subject_ref<>$8`,
      [input.approvalRef, input.siteRef, input.environment, input.region, input.operation,
        input.effectDigest, context.requestId, context.actor.subjectId],
    );
    if (changed !== 1) throw new Error("SITE_EFFECT_APPROVAL_CONSUME_CONFLICT");
  }
}

function verifyIdentity(input: ApprovalIdentity): void {
  uuid(input.approvalRef, "SITE_APPROVAL_REF_INVALID");
  identifier(input.siteRef, "SITE_REF_INVALID");
  if (!["development", "preview", "production"].includes(input.environment)) {
    throw new Error("SITE_APPROVAL_ENVIRONMENT_INVALID");
  }
  if (input.region.length < 1 || input.region.length > 64 || hasControl(input.region)) {
    throw new Error("SITE_APPROVAL_REGION_INVALID");
  }
  if (!["site.activation.begin", "site.traffic-stop.suspend", "site.traffic-stop.decommission"]
    .includes(input.operation)) throw new Error("SITE_APPROVAL_OPERATION_INVALID");
  if (!/^[a-f0-9]{64}$/u.test(input.effectDigest)) throw new Error("SITE_APPROVAL_DIGEST_INVALID");
}
function identifier(value: string, code: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,191}$/u.test(value)) throw new Error(code);
}
function uuid(value: string, code: string): void {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value)) {
    throw new Error(code);
  }
}
function instant(value: string, code: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(code);
}
function verifyReason(value: string): void {
  if (value.length < 3 || value.length > 512 || hasControl(value)) {
    throw new Error("SITE_APPROVAL_REASON_INVALID");
  }
}
function hasControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point < 32 || point === 127;
  });
}
function approvalState(value: unknown): "pending" | "approved" | "consumed" {
  if (value !== "pending" && value !== "approved" && value !== "consumed") {
    throw new Error("SITE_EFFECT_APPROVAL_ROW_CORRUPT");
  }
  return value;
}
function instantValue(value: unknown): string {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (date === null || !Number.isFinite(date.getTime())) {
    throw new Error("SITE_EFFECT_APPROVAL_ROW_CORRUPT");
  }
  return date.toISOString();
}
