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
  readonly operation: SiteDangerousOperation;
  readonly effectDigest: string;
}

export class PostgresSiteEffectApprovalAuthority implements SiteEffectApprovalAdministration {
  async request(
    transaction: PlatformTransaction,
    input: ApprovalIdentity & Readonly<{ makerSubjectRef: string; requestedAt: string; expiresAt: string }>,
  ): Promise<void> {
    verifyIdentity(input);
    identifier(input.makerSubjectRef, "SITE_APPROVAL_MAKER_INVALID");
    instant(input.requestedAt, "SITE_APPROVAL_TIME_INVALID");
    instant(input.expiresAt, "SITE_APPROVAL_TIME_INVALID");
    if (Date.parse(input.expiresAt) <= Date.parse(input.requestedAt)) {
      throw new Error("SITE_APPROVAL_EXPIRY_INVALID");
    }
    const sql = resolvePlatformTransaction(transaction);
    const inserted = await sql.execute(
      `INSERT INTO platform.site_effect_approval
       (approval_ref,site_ref,operation,effect_digest,state,maker_subject_ref,requested_at,expires_at)
       VALUES ($1,$2,$3,$4,'pending',$5,$6::timestamptz,$7::timestamptz)
       ON CONFLICT (approval_ref) DO NOTHING`,
      [input.approvalRef, input.siteRef, input.operation, input.effectDigest,
        input.makerSubjectRef, input.requestedAt, input.expiresAt],
    );
    if (inserted === 1) return;
    const existing = await sql.query<{ exact: boolean }>(
      `SELECT site_ref=$2 AND operation=$3 AND effect_digest=$4 AND maker_subject_ref=$5
              AS exact
       FROM platform.site_effect_approval WHERE approval_ref=$1`,
      [input.approvalRef, input.siteRef, input.operation, input.effectDigest, input.makerSubjectRef],
    );
    if (existing[0]?.exact !== true) throw new Error("SITE_EFFECT_APPROVAL_REQUEST_CONFLICT");
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
       SET state='approved',checker_subject_ref=$6,decided_at=$5::timestamptz,updated_at=now()
       WHERE approval_ref=$1 AND site_ref=$2 AND operation=$3 AND effect_digest=$4
         AND state='pending' AND expires_at>$5::timestamptz AND maker_subject_ref<>$6`,
      [input.approvalRef, input.siteRef, input.operation, input.effectDigest,
        input.decidedAt, input.checkerSubjectRef],
    );
    if (changed === 1) return;
    const existing = await resolvePlatformTransaction(transaction).query<{ exact: boolean }>(
      `SELECT site_ref=$2 AND operation=$3 AND effect_digest=$4
              AND checker_subject_ref=$5 AND state IN ('approved','consumed') AS exact
       FROM platform.site_effect_approval WHERE approval_ref=$1`,
      [input.approvalRef, input.siteRef, input.operation, input.effectDigest, input.checkerSubjectRef],
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
    const changed = await resolvePlatformTransaction(transaction).execute(
      `UPDATE platform.site_effect_approval
       SET state='consumed',consumed_request_id=$5,consumed_at=now(),updated_at=now()
       WHERE approval_ref=$1 AND site_ref=$2 AND operation=$3 AND effect_digest=$4
         AND state='approved' AND expires_at>now() AND checker_subject_ref=$6
         AND maker_subject_ref<>$6`,
      [input.approvalRef, input.siteRef, input.operation, input.effectDigest,
        context.requestId, context.actor.subjectId],
    );
    if (changed !== 1) throw new Error("SITE_EFFECT_APPROVAL_CONSUME_CONFLICT");
  }
}

function verifyIdentity(input: ApprovalIdentity): void {
  identifier(input.approvalRef, "SITE_APPROVAL_REF_INVALID");
  identifier(input.siteRef, "SITE_REF_INVALID");
  if (!["site.activation.begin", "site.traffic-stop.suspend", "site.traffic-stop.decommission"]
    .includes(input.operation)) throw new Error("SITE_APPROVAL_OPERATION_INVALID");
  if (!/^[a-f0-9]{64}$/u.test(input.effectDigest)) throw new Error("SITE_APPROVAL_DIGEST_INVALID");
}
function identifier(value: string, code: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,191}$/u.test(value)) throw new Error(code);
}
function instant(value: string, code: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(code);
}
