import type { JsonValue } from "../../../../shared/outbox-inbox/receipt.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import { resolvePlatformTransaction } from
  "../../../../shared/unit-of-work/platform-transaction.js";
import type {
  AdminAuthorityRepositoryPort,
  AdminDecisionRecord,
} from "../../application/admin-command-service.js";
import type { AdminApprovalRepositoryPort } from "../../application/admin-approval-service.js";
import type { AdminApprovalRecord } from "../../domain/admin-approval.js";
import type { AdminOperatorAuthority } from "../../domain/admin-command.js";

export class PostgresAdminAuthorityRepository implements
  AdminAuthorityRepositoryPort,
  AdminApprovalRepositoryPort {
  async lockOperatorAuthority(
    transaction: PlatformTransaction,
    input: Readonly<{ operatorRef: string; operatorGeneration: bigint }>,
  ): Promise<AdminOperatorAuthority | null> {
    const rows = await resolvePlatformTransaction(transaction).query<OperatorRow>(
      `SELECT operator_ref AS "operatorRef", operator_generation AS "operatorGeneration",
              state, permissions, site_scopes AS "siteScopes", environments, regions,
              authorization_epoch AS "authorizationEpoch", expires_at AS "expiresAt",
              break_glass_expires_at AS "breakGlassExpiresAt"
       FROM platform.admin_operator_authority
       WHERE operator_ref=$1 AND operator_generation=$2
       FOR UPDATE`,
      [input.operatorRef, input.operatorGeneration],
    );
    const row = rows[0];
    if (!row) return null;
    return Object.freeze({
      operatorRef: row.operatorRef,
      operatorGeneration: BigInt(row.operatorGeneration),
      state: state(row.state),
      permissions: strings(row.permissions),
      siteScopes: strings(row.siteScopes),
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
              expires_at AS "expiresAt", state, revision
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
}

interface OperatorRow extends Record<string, unknown> {
  operatorRef: string;
  operatorGeneration: bigint | string;
  state: string;
  permissions: readonly string[];
  siteScopes: readonly string[];
  environments: readonly string[];
  regions: readonly string[];
  authorizationEpoch: bigint | string;
  expiresAt: Date | string;
  breakGlassExpiresAt: Date | string | null;
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
}

function state(value: string): AdminOperatorAuthority["state"] {
  if (value !== "active" && value !== "suspended") throw new Error("ADMIN_OPERATOR_ROW_INVALID");
  return value;
}

function approvalState(value: string): AdminApprovalRecord["state"] {
  if (!["pending", "executed", "rejected", "effect_rejected", "expired"].includes(value)) {
    throw new Error("ADMIN_APPROVAL_ROW_INVALID");
  }
  return value as AdminApprovalRecord["state"];
}

function strings(value: readonly string[]): readonly string[] {
  return Object.freeze([...value]);
}

function instant(value: Date | string): string {
  const result = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(result.getTime())) throw new Error("ADMIN_TIME_INVALID");
  return result.toISOString();
}
