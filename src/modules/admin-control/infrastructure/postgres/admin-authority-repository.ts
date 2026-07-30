import type { JsonValue } from "../../../../shared/outbox-inbox/receipt.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import { resolvePlatformTransaction } from
  "../../../../shared/unit-of-work/platform-transaction.js";
import type {
  AdminAuthorityRepositoryPort,
  AdminDecisionRecord,
} from "../../application/admin-command-service.js";
import type { AdminApprovalRepositoryPort } from "../../application/admin-approval-service.js";
import type {
  AdminPostEffectReviewRecord,
  AdminPostEffectReviewRepositoryPort,
} from "../../application/admin-post-effect-review-service.js";
import type { AdminApprovalRecord } from "../../domain/admin-approval.js";
import type { AdminOperatorAuthority } from "../../domain/admin-command.js";
import type {
  AdminWorkerOperatorAuthorityLock,
  AdminWorkerOperatorAuthorityRow as OperatorRow,
} from "./admin-worker-operator-authority-lock.js";

export class PostgresAdminAuthorityRepository implements
  AdminAuthorityRepositoryPort,
  AdminApprovalRepositoryPort,
  AdminPostEffectReviewRepositoryPort {
  constructor(private readonly workerOperatorAuthorityLock?: AdminWorkerOperatorAuthorityLock) {}

  async lockOperatorAuthority(
    transaction: PlatformTransaction,
    input: Readonly<{ operatorRef: string; operatorGeneration: bigint }>,
  ): Promise<AdminOperatorAuthority | null> {
    const sql = resolvePlatformTransaction(transaction);
    const row = this.workerOperatorAuthorityLock === undefined
      ? (await sql.query<OperatorRow>(
      `SELECT authority.operator_ref AS "operatorRef",
              authority.operator_generation AS "operatorGeneration",
              authority.state,authority.permissions,
              ARRAY(SELECT DISTINCT site_scope.site_ref
                    FROM platform.admin_operator_site_scope site_scope
                    WHERE site_scope.operator_ref=authority.operator_ref
                      AND site_scope.operator_generation=authority.operator_generation
                      AND site_scope.state='active' AND site_scope.expires_at>now()) AS "siteScopes",
              ARRAY(SELECT grant_ref::text
                    FROM platform.admin_operator_global_scope_grant global_scope
                    WHERE global_scope.operator_ref=authority.operator_ref
                      AND global_scope.operator_generation=authority.operator_generation
                      AND global_scope.state='active' AND global_scope.expires_at>now()) AS "globalScopes",
              ARRAY(SELECT DISTINCT deployment.environment FROM (
                SELECT environment FROM platform.admin_operator_site_scope
                 WHERE operator_ref=authority.operator_ref AND operator_generation=authority.operator_generation
                   AND state='active' AND expires_at>now()
                UNION SELECT environment FROM platform.admin_operator_global_scope_grant
                 WHERE operator_ref=authority.operator_ref AND operator_generation=authority.operator_generation
                   AND state='active' AND expires_at>now()
              ) deployment) AS environments,
              ARRAY(SELECT DISTINCT deployment.region FROM (
                SELECT region FROM platform.admin_operator_site_scope
                 WHERE operator_ref=authority.operator_ref AND operator_generation=authority.operator_generation
                   AND state='active' AND expires_at>now()
                UNION SELECT region FROM platform.admin_operator_global_scope_grant
                 WHERE operator_ref=authority.operator_ref AND operator_generation=authority.operator_generation
                   AND state='active' AND expires_at>now()
              ) deployment) AS regions,
              authority.authorization_epoch AS "authorizationEpoch",
              authority.expires_at AS "expiresAt",
              (SELECT max(expires_at) FROM platform.admin_breakglass_grant breakglass
               WHERE breakglass.operator_ref=authority.operator_ref
                 AND breakglass.operator_generation=authority.operator_generation
                 AND breakglass.state='active' AND breakglass.expires_at>now()) AS "breakGlassExpiresAt"
       FROM platform.admin_operator_authority authority
       WHERE authority.operator_ref=$1 AND authority.operator_generation=$2
       FOR UPDATE`,
      [input.operatorRef, input.operatorGeneration],
    ))[0]
      : await this.workerOperatorAuthorityLock.lock(sql, input);
    if (!row) return null;
    return Object.freeze({
      operatorRef: row.operatorRef,
      operatorGeneration: BigInt(row.operatorGeneration),
      state: state(row.state),
      permissions: strings(row.permissions),
      siteScopes: strings(row.siteScopes),
      globalScopes: strings(row.globalScopes),
      environments: strings(row.environments),
      regions: strings(row.regions),
      authorizationEpoch: BigInt(row.authorizationEpoch),
      expiresAt: instant(row.expiresAt),
      breakGlassExpiresAt: row.breakGlassExpiresAt === null ? null : instant(row.breakGlassExpiresAt),
    });
  }

  async recordDecision(
    transaction: PlatformTransaction,
    decision: AdminDecisionRecord,
  ): Promise<void> {
    await resolvePlatformTransaction(transaction).execute(
      `INSERT INTO platform.admin_command_decision
       (decision_ref,command_id,request_digest,operator_ref,operator_generation,operation,
        target_site_ref,environment,region,allowed,reason_code,effect_class,approval_policy,
        operator_reason,break_glass_ticket_ref,authorization_epoch,occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [decision.decisionRef, decision.commandId, decision.requestDigest, decision.operatorRef,
        decision.operatorGeneration, decision.operation, decision.targetSiteRef, decision.environment,
        decision.region, decision.allowed, decision.reasonCode, decision.effectClass,
        decision.approvalPolicy, decision.operatorReason, decision.breakGlassTicketRef,
        decision.authorizationEpoch, decision.occurredAt],
    );
  }

  async createApproval(
    transaction: PlatformTransaction,
    input: Parameters<AdminAuthorityRepositoryPort["createApproval"]>[1],
  ): Promise<void> {
    const changed = await resolvePlatformTransaction(transaction).execute(
      `INSERT INTO platform.admin_approval
       (approval_ref,command_id,request_digest,payload,payload_digest,operation,maker_ref,
        maker_generation,maker_authorization_epoch,target_site_ref,environment,region,
        effect_class,approval_policy,operator_reason,admitted_at,expires_at)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (command_id) DO NOTHING`,
      [input.approvalRef, input.commandId, input.requestDigest, JSON.stringify(input.payload),
        input.payloadDigest, input.admission.commandId, input.admission.operatorRef,
        input.admission.operatorGeneration, input.admission.authorizationEpoch,
        input.admission.siteRef, input.admission.environment, input.admission.region,
        input.admission.effectClass, input.admission.approvalPolicy, input.admission.reason,
        input.admission.admittedAt, input.expiresAt],
    );
    if (changed !== 1) throw new Error("ADMIN_APPROVAL_COMMAND_CONFLICT");
  }

  async createPostEffectReview(
    transaction: PlatformTransaction,
    input: Parameters<AdminAuthorityRepositoryPort["createPostEffectReview"]>[1],
  ): Promise<void> {
    const changed = await resolvePlatformTransaction(transaction).execute(
      `INSERT INTO platform.admin_post_effect_review
       (review_ref,command_id,request_digest,operation,required_permission,maker_ref,maker_generation,
        maker_authorization_epoch,target_site_ref,environment,region,break_glass_ticket_ref,
        outcome,outcome_digest,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15)
       ON CONFLICT (command_id) DO NOTHING`,
      [input.reviewRef, input.commandId, input.requestDigest, input.operation,
        input.requiredPermission, input.admission.operatorRef, input.admission.operatorGeneration,
        input.admission.authorizationEpoch, input.admission.siteRef, input.admission.environment,
        input.admission.region, input.breakGlassTicketRef, JSON.stringify(input.outcome),
        input.outcomeDigest, input.expiresAt],
    );
    if (changed !== 1) throw new Error("ADMIN_POST_EFFECT_REVIEW_CONFLICT");
  }

  async lockApproval(
    transaction: PlatformTransaction,
    approvalRef: string,
  ): Promise<AdminApprovalRecord | null> {
    const rows = await resolvePlatformTransaction(transaction).query<ApprovalRow>(
      `SELECT approval_ref::text AS "approvalRef", command_id AS "commandId",
              request_digest AS "requestDigest", payload, payload_digest AS "payloadDigest",
              operation, maker_ref AS "makerRef", maker_generation AS "makerGeneration",
              maker_authorization_epoch AS "makerAuthorizationEpoch",
              target_site_ref AS "targetSiteRef", environment, region,
              effect_class AS "effectClass", approval_policy AS "approvalPolicy",
              operator_reason AS "operatorReason", admitted_at AS "admittedAt",
              expires_at AS "expiresAt", state, revision,
              checker_ref AS "checkerRef", checker_generation AS "checkerGeneration",
              checker_authorization_epoch AS "checkerAuthorizationEpoch",
              checker_decision AS "checkerDecision", checker_reason AS "checkerReason",
              decided_at AS "decidedAt"
       FROM platform.admin_approval
       WHERE approval_ref=$1::uuid
       FOR UPDATE`,
      [approvalRef],
    );
    const row = rows[0];
    if (!row) return null;
    if (row.effectClass !== "dangerous" || row.approvalPolicy !== "pre_effect") {
      throw new Error("ADMIN_APPROVAL_ROW_INVALID");
    }
    return Object.freeze({
      approvalRef: row.approvalRef,
      commandId: row.commandId,
      requestDigest: row.requestDigest,
      payload: row.payload,
      payloadDigest: row.payloadDigest,
      checker: checker(row),
      state: approvalState(row.state),
      revision: BigInt(row.revision),
      expiresAt: instant(row.expiresAt),
      admission: Object.freeze({
        commandId: row.operation,
        operatorRef: row.makerRef,
        operatorGeneration: BigInt(row.makerGeneration),
        authorizationEpoch: BigInt(row.makerAuthorizationEpoch),
        siteRef: row.targetSiteRef,
        environment: row.environment,
        region: row.region,
        effectClass: "dangerous",
        approvalPolicy: "pre_effect",
        reason: row.operatorReason,
        breakGlassTicketRef: null,
        admittedAt: instant(row.admittedAt),
      }),
    });
  }

  async transitionApproval(
    transaction: PlatformTransaction,
    input: Parameters<AdminApprovalRepositoryPort["transitionApproval"]>[1],
  ): Promise<boolean> {
    const changed = await resolvePlatformTransaction(transaction).execute(
      `UPDATE platform.admin_approval
       SET state=$1, revision=revision+1, checker_ref=$2, checker_generation=$3,
           checker_authorization_epoch=$4, checker_decision=$5, checker_reason=$6,
           result=$7::jsonb, result_digest=$8, decided_at=$9, updated_at=now()
       WHERE approval_ref=$10::uuid AND state='pending' AND revision=$11`,
      [input.state, input.checker.checkerRef, input.checker.checkerGeneration,
        input.checker.checkerAuthorizationEpoch, input.checker.decision, input.checker.reason,
        JSON.stringify(input.result), input.resultDigest, input.checker.admittedAt,
        input.approvalRef, input.expectedRevision],
    );
    return changed === 1;
  }

  async completeExecution(
    transaction: PlatformTransaction,
    input: Readonly<{
      approvalRef: string;
      expectedRevision: bigint;
      state: "executed" | "effect_rejected" | "stale_authority";
      result: JsonValue;
      resultDigest: string;
      code: string | null;
    }>,
  ): Promise<boolean> {
    const changed = await resolvePlatformTransaction(transaction).execute(
      `UPDATE platform.admin_approval
       SET state=$1, revision=revision+1, result=$2::jsonb, result_digest=$3,
           terminal_reason=$4, updated_at=now()
       WHERE approval_ref=$5::uuid AND state='execution_queued' AND revision=$6`,
      [input.state, JSON.stringify(input.result), input.resultDigest, input.code,
        input.approvalRef, input.expectedRevision],
    );
    return changed === 1;
  }

  async recordApprovalDecision(
    transaction: PlatformTransaction,
    input: Parameters<AdminApprovalRepositoryPort["recordApprovalDecision"]>[1],
  ): Promise<void> {
    await resolvePlatformTransaction(transaction).execute(
       `INSERT INTO platform.admin_approval_decision
       (decision_ref,approval_ref,execution_command_id,checker_ref,checker_generation,
        checker_authorization_epoch,target_site_ref,environment,region,allowed,reason_code,
        request_digest,occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [input.decisionRef, input.approvalRef, input.executionCommandId, input.checkerRef,
        input.checkerGeneration, input.checkerAuthorizationEpoch, input.targetSiteRef,
        input.environment, input.region, input.allowed, input.reasonCode, input.requestDigest,
        input.occurredAt],
    );
  }

  async lockReview(
    transaction: PlatformTransaction,
    reviewRef: string,
  ): Promise<AdminPostEffectReviewRecord | null> {
    const rows = await resolvePlatformTransaction(transaction).query<PostEffectReviewRow>(
      `SELECT review_ref::text AS "reviewRef",command_id AS "commandId",operation,
              required_permission AS "requiredPermission",maker_ref AS "makerRef",
              maker_generation AS "makerGeneration",
              maker_authorization_epoch AS "makerAuthorizationEpoch",
              target_site_ref AS "siteRef",environment,region,state,revision,
              expires_at AS "expiresAt"
       FROM platform.admin_post_effect_review
       WHERE review_ref=$1::uuid
       FOR UPDATE`,
      [reviewRef],
    );
    const row = rows[0];
    if (row === undefined) return null;
    const state = postEffectReviewState(row.state);
    return Object.freeze({
      ...row,
      state,
      makerGeneration: BigInt(row.makerGeneration),
      makerAuthorizationEpoch: BigInt(row.makerAuthorizationEpoch),
      revision: BigInt(row.revision),
      expiresAt: instant(row.expiresAt),
    });
  }

  async transitionReview(
    transaction: PlatformTransaction,
    input: Parameters<AdminPostEffectReviewRepositoryPort["transitionReview"]>[1],
  ): Promise<boolean> {
    const changed = await resolvePlatformTransaction(transaction).execute(
      `UPDATE platform.admin_post_effect_review
       SET state=$1,revision=revision+1,reviewer_ref=$2,reviewer_generation=$3,
           reviewer_authorization_epoch=$4,reviewer_reason=$5,reviewed_at=$6::timestamptz
       WHERE review_ref=$7::uuid AND state='pending' AND revision=$8`,
      [input.state, input.reviewerRef, input.reviewerGeneration,
        input.reviewerAuthorizationEpoch, input.reason, input.reviewedAt,
        input.reviewRef, input.expectedRevision],
    );
    return changed === 1;
  }

  async terminalizeApprovals(
    transaction: PlatformTransaction,
    now: string,
  ): Promise<number> {
    const sql = resolvePlatformTransaction(transaction);
    const pending = await sql.execute(
      `UPDATE platform.admin_approval approval
       SET state=CASE WHEN approval.expires_at<=$1::timestamptz THEN 'expired'
                      ELSE 'stale_authority' END,
           revision=approval.revision+1,
           result=jsonb_build_object(
             'code',CASE WHEN approval.expires_at<=$1::timestamptz
                         THEN 'ADMIN_APPROVAL_EXPIRED' ELSE 'ADMIN_APPROVAL_MAKER_STALE' END),
           result_digest=CASE WHEN approval.expires_at<=$1::timestamptz
             THEN 'ee06a990e905cdfb6b3681904c85b20387bd68012957cfd966d673a69f47805d'
             ELSE '954a1ad9a6da7dbd16c69e46df052e8915ab2b2fac969b18fec7ff64f84805c6' END,
           terminal_reason=CASE WHEN approval.expires_at<=$1::timestamptz
                                THEN 'ADMIN_APPROVAL_EXPIRED' ELSE 'ADMIN_APPROVAL_MAKER_STALE' END,
           updated_at=$1::timestamptz
       FROM platform.admin_operator_authority maker
       WHERE approval.state='pending'
         AND maker.operator_ref=approval.maker_ref
         AND maker.operator_generation=approval.maker_generation
         AND (approval.expires_at<=$1::timestamptz OR maker.state<>'active'
              OR maker.authorization_epoch<>approval.maker_authorization_epoch
              OR maker.expires_at<=$1::timestamptz)`,
      [now],
    );
    const orphaned = await sql.execute(
      `UPDATE platform.admin_approval approval
       SET state='effect_rejected',revision=approval.revision+1,
           result=jsonb_build_object('code','ADMIN_EXECUTION_ORPHANED'),
           result_digest='93cfcb5bcd27b14942713e2c8defad6697d7715eba1c89c7089d38b02b96905b',
           terminal_reason='ADMIN_EXECUTION_ORPHANED',updated_at=$1::timestamptz
       WHERE approval.state='execution_queued'
         AND approval.updated_at<=$1::timestamptz-make_interval(mins => 5)
         AND NOT EXISTS (
           SELECT 1 FROM platform.outbox_event event
           WHERE event.owner='admin-execution'
             AND event.aggregate_id=approval.approval_ref::text
             AND event.state IN ('pending','leased')
         )`,
      [now],
    );
    return pending + orphaned;
  }

  async terminalizePostEffectReviews(
    transaction: PlatformTransaction,
    now: string,
  ): Promise<number> {
    return resolvePlatformTransaction(transaction).execute(
      `UPDATE platform.admin_post_effect_review
       SET state='expired',revision=revision+1,terminal_reason='ADMIN_POST_EFFECT_REVIEW_EXPIRED',
           reviewed_at=$1::timestamptz
       WHERE state='pending' AND expires_at<=$1::timestamptz`,
      [now],
    );
  }
}

interface ApprovalRow extends Record<string, unknown> {
  approvalRef: string;
  commandId: string;
  requestDigest: string;
  payload: JsonValue;
  payloadDigest: string;
  operation: string;
  makerRef: string;
  makerGeneration: bigint | string;
  makerAuthorizationEpoch: bigint | string;
  targetSiteRef: string | null;
  environment: string;
  region: string;
  effectClass: string;
  approvalPolicy: string;
  operatorReason: string;
  admittedAt: Date | string;
  expiresAt: Date | string;
  state: string;
  revision: bigint | string;
  checkerRef: string | null;
  checkerGeneration: bigint | string | null;
  checkerAuthorizationEpoch: bigint | string | null;
  checkerDecision: string | null;
  checkerReason: string | null;
  decidedAt: Date | string | null;
}

interface PostEffectReviewRow extends Record<string, unknown> {
  reviewRef: string;
  commandId: string;
  operation: string;
  requiredPermission: string;
  makerRef: string;
  makerGeneration: bigint | string;
  makerAuthorizationEpoch: bigint | string;
  siteRef: string | null;
  environment: string;
  region: string;
  state: string;
  revision: bigint | string;
  expiresAt: Date | string;
}

function state(value: string): AdminOperatorAuthority["state"] {
  if (value !== "active" && value !== "suspended" && value !== "revoked") {
    throw new Error("ADMIN_OPERATOR_ROW_INVALID");
  }
  return value;
}

function approvalState(value: string): AdminApprovalRecord["state"] {
  if (!["pending", "execution_queued", "executed", "rejected", "effect_rejected", "expired",
    "stale_authority"].includes(value)) {
    throw new Error("ADMIN_APPROVAL_ROW_INVALID");
  }
  return value as AdminApprovalRecord["state"];
}

function postEffectReviewState(value: string): AdminPostEffectReviewRecord["state"] {
  if (!["pending", "acknowledged", "escalated", "expired"].includes(value)) {
    throw new Error("ADMIN_POST_EFFECT_REVIEW_ROW_INVALID");
  }
  return value as AdminPostEffectReviewRecord["state"];
}

function strings(value: readonly string[]): readonly string[] {
  return Object.freeze([...value]);
}

function instant(value: Date | string): string {
  const result = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(result.getTime())) throw new Error("ADMIN_TIME_INVALID");
  return result.toISOString();
}

function checker(row: ApprovalRow): import("../../domain/admin-approval.js").AdminApprovalAdmission | null {
  if (row.checkerRef === null) return null;
  if (
    row.checkerGeneration === null || row.checkerAuthorizationEpoch === null ||
    (row.checkerDecision !== "approve" && row.checkerDecision !== "reject") ||
    row.checkerReason === null || row.decidedAt === null
  ) throw new Error("ADMIN_APPROVAL_ROW_INVALID");
  return Object.freeze({
    approvalRef: row.approvalRef,
    commandId: row.commandId,
    ownerOperation: row.operation,
    checkerRef: row.checkerRef,
    checkerGeneration: BigInt(row.checkerGeneration),
    checkerAuthorizationEpoch: BigInt(row.checkerAuthorizationEpoch),
    makerRef: row.makerRef,
    makerGeneration: BigInt(row.makerGeneration),
    makerAuthorizationEpoch: BigInt(row.makerAuthorizationEpoch),
    siteRef: row.targetSiteRef,
    environment: row.environment,
    region: row.region,
    decision: row.checkerDecision,
    reason: row.checkerReason,
    admittedAt: instant(row.decidedAt),
  });
}
