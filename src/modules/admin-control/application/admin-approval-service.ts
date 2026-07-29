import type { CommandIdentity, CommandReceipt, JsonValue } from
  "../../../shared/outbox-inbox/receipt.js";
import type { OutboxEvent } from "../../../shared/outbox-inbox/outbox.js";
import type { VerifiedRequestSecurityContext } from "../../../shared/security-context/index.js";
import type { PlatformTransaction } from "../../../shared/unit-of-work/index.js";
import { digestAdminValue } from "./admin-digest.js";
import type {
  AdminAuthorityRepositoryPort,
  AdminLocalCommandRegistry,
  AdminOutboxPort,
  AdminReceiptPort,
  AdminUnitOfWorkPort,
} from "./admin-command-service.js";
import {
  admitAdminApproval,
  type AdminApprovalAdmission,
  type AdminApprovalRecord,
  type AdminApprovalState,
} from "../domain/admin-approval.js";

export interface AdminApprovalRepositoryPort extends Pick<
  AdminAuthorityRepositoryPort,
  "lockOperatorAuthority"
> {
  lockApproval(transaction: PlatformTransaction, approvalRef: string): Promise<AdminApprovalRecord | null>;
  transitionApproval(
    transaction: PlatformTransaction,
    input: Readonly<{
      approvalRef: string;
      expectedRevision: bigint;
      state: Exclude<AdminApprovalState, "pending">;
      checker: AdminApprovalAdmission;
      result: JsonValue;
      resultDigest: string;
    }>,
  ): Promise<boolean>;
  recordApprovalDecision(
    transaction: PlatformTransaction,
    input: Readonly<{
      decisionRef: string;
      approvalRef: string;
      executionCommandId: string;
      checkerRef: string;
      targetSiteRef: string | null;
      environment: string;
      region: string;
      allowed: boolean;
      reasonCode: string;
      requestDigest: string;
      occurredAt: string;
    }>,
  ): Promise<void>;
}

export type AdminApprovalSubmissionResult = Readonly<{
  disposition: "executed" | "rejected" | "effect_rejected" | "denied";
  commandId: string;
  approvalRef: string;
  code?: string;
  result?: JsonValue;
}>;

export class AdminApprovalService {
  constructor(private readonly dependencies: Readonly<{
    unitOfWork: AdminUnitOfWorkPort;
    registry: AdminLocalCommandRegistry;
    repository: AdminApprovalRepositoryPort;
    receipts: AdminReceiptPort;
    outbox: AdminOutboxPort;
    clock?: () => Date;
    reference: () => string;
  }>) {}

  async decide(input: Readonly<{
    context: VerifiedRequestSecurityContext;
    commandId: string;
    idempotencyKey: string;
    approvalRef: string;
    decision: "approve" | "reject";
    reason: string;
  }>): Promise<AdminApprovalSubmissionResult> {
    bounded(input.approvalRef, "ADMIN_APPROVAL_REF_INVALID");
    bounded(input.idempotencyKey, "ADMIN_IDEMPOTENCY_KEY_INVALID");
    const requestDigest = digestAdminValue({
      commandId: input.commandId,
      operation: "admin.approval.execute",
      approvalRef: input.approvalRef,
      decision: input.decision,
      reason: input.reason,
      checkerRef: input.context.actor.subjectId,
      checkerGeneration: input.context.actor.subjectGeneration,
      environment: input.context.environment,
      region: input.context.region,
    });
    const identity: CommandIdentity = Object.freeze({
      commandId: input.commandId,
      environment: input.context.environment,
      region: input.context.region,
      callerIdentity: `${input.context.trustedCaller.workloadIdentityId}:${input.context.actor.subjectId}:${input.context.actor.subjectGeneration}`,
      operation: "admin.approval.execute",
      idempotencyKey: input.idempotencyKey,
      requestDigest,
    });
    return this.dependencies.unitOfWork.execute(
      { context: input.context, operation: "admin.approval.execute" },
      async (transaction) => {
        let receipt: CommandReceipt;
        try {
          receipt = await this.dependencies.receipts.begin(transaction, identity);
        } catch (error) {
          if (error instanceof Error && error.message === "COMMAND_DIGEST_CONFLICT") {
            await this.audit(transaction, input, requestDigest, false, "ADMIN_IDEMPOTENCY_CONFLICT");
            return Object.freeze({ disposition: "denied", commandId: input.commandId,
              approvalRef: input.approvalRef, code: "ADMIN_IDEMPOTENCY_CONFLICT" });
          }
          throw error;
        }
        if (receipt.state === "succeeded" || receipt.state === "failed") return restore(receipt);
        const approval = await this.dependencies.repository.lockApproval(transaction, input.approvalRef);
        if (approval === null) return this.denied(transaction, input, identity, requestDigest,
          "ADMIN_APPROVAL_NOT_FOUND");
        if (approval.payloadDigest !== digestAdminValue(approval.payload)) {
          return this.denied(transaction, input, identity, requestDigest, "ADMIN_APPROVAL_PAYLOAD_INVALID");
        }
        let handler;
        try {
          handler = this.dependencies.registry.require(approval.admission.commandId);
        } catch {
          return this.denied(transaction, input, identity, requestDigest, "ADMIN_APPROVAL_COMMAND_INVALID");
        }
        const makerIdentity = Object.freeze({
          operatorRef: approval.admission.operatorRef,
          operatorGeneration: approval.admission.operatorGeneration,
        });
        const checkerIdentity = Object.freeze({
          operatorRef: input.context.actor.subjectId,
          operatorGeneration: epoch(input.context.actor.subjectGeneration),
        });
        const authorities = new Map<string, Awaited<ReturnType<
          AdminApprovalRepositoryPort["lockOperatorAuthority"]
        >>>();
        for (const identity of [makerIdentity, checkerIdentity].sort((left, right) =>
          left.operatorRef.localeCompare(right.operatorRef))) {
          authorities.set(identity.operatorRef,
            await this.dependencies.repository.lockOperatorAuthority(transaction, identity));
        }
        const makerAuthority = authorities.get(makerIdentity.operatorRef) ?? null;
        const checkerAuthority = authorities.get(checkerIdentity.operatorRef) ?? null;
        if (makerAuthority === null || checkerAuthority === null) {
          return this.denied(transaction, input, identity, requestDigest, "ADMIN_APPROVAL_AUTHORITY_NOT_FOUND");
        }
        let admission: AdminApprovalAdmission;
        try {
          admission = admitAdminApproval({ approval, definition: handler.definition, context: input.context,
            makerAuthority, checkerAuthority, decision: input.decision, reason: input.reason, now: this.now() });
        } catch (error) {
          return this.denied(transaction, input, identity, requestDigest, safeCode(error));
        }
        await this.audit(transaction, input, requestDigest, true, "ALLOW");
        if (input.decision === "reject") {
          const result = json({ disposition: "rejected", commandId: input.commandId,
            approvalRef: input.approvalRef });
          await this.transition(transaction, approval, admission, "rejected", result);
          await this.complete(transaction, identity, "succeeded", result);
          await this.event(transaction, input, admission, "admin.approval.rejected", result);
          return Object.freeze({ disposition: "rejected", commandId: input.commandId,
            approvalRef: input.approvalRef });
        }
        const outcome = await handler.execute(transaction, {
          admission: approval.admission,
          approval: admission,
          payload: approval.payload,
          requestDigest: approval.requestDigest,
        });
        if (outcome.disposition === "rejected") {
          const result = json({ disposition: "effect_rejected", commandId: input.commandId,
            approvalRef: input.approvalRef, code: outcome.code });
          await this.transition(transaction, approval, admission, "effect_rejected", result);
          await this.complete(transaction, identity, "failed", result);
          await this.event(transaction, input, admission, "admin.approval.effect-rejected", result);
          return Object.freeze({ disposition: "effect_rejected", commandId: input.commandId,
            approvalRef: input.approvalRef, code: outcome.code });
        }
        const result = json({ disposition: "executed", commandId: input.commandId,
          approvalRef: input.approvalRef, result: outcome.result });
        await this.transition(transaction, approval, admission, "executed", result);
        await this.complete(transaction, identity, "succeeded", result);
        await this.event(transaction, input, admission, "admin.approval.executed", result);
        return Object.freeze({ disposition: "executed", commandId: input.commandId,
          approvalRef: input.approvalRef, result: outcome.result });
      },
    );
  }

  private async denied(
    transaction: PlatformTransaction,
    input: Readonly<{ context: VerifiedRequestSecurityContext; commandId: string; approvalRef: string }>,
    identity: CommandIdentity,
    requestDigest: string,
    code: string,
  ): Promise<AdminApprovalSubmissionResult> {
    await this.audit(transaction, input, requestDigest, false, code);
    const result = json({ disposition: "denied", commandId: input.commandId,
      approvalRef: input.approvalRef, code });
    await this.complete(transaction, identity, "failed", result);
    return Object.freeze({ disposition: "denied", commandId: input.commandId,
      approvalRef: input.approvalRef, code });
  }

  private audit(
    transaction: PlatformTransaction,
    input: Readonly<{ context: VerifiedRequestSecurityContext; commandId: string; approvalRef: string }>,
    requestDigest: string,
    allowed: boolean,
    reasonCode: string,
  ): Promise<void> {
    return this.dependencies.repository.recordApprovalDecision(transaction, {
      decisionRef: this.dependencies.reference(), approvalRef: input.approvalRef,
      executionCommandId: input.commandId, checkerRef: input.context.actor.subjectId,
      targetSiteRef: input.context.target.siteId, environment: input.context.environment,
      region: input.context.region, allowed, reasonCode, requestDigest, occurredAt: this.now(),
    });
  }

  private async transition(
    transaction: PlatformTransaction,
    approval: AdminApprovalRecord,
    checker: AdminApprovalAdmission,
    state: Exclude<AdminApprovalState, "pending">,
    result: JsonValue,
  ): Promise<void> {
    const changed = await this.dependencies.repository.transitionApproval(transaction, {
      approvalRef: approval.approvalRef, expectedRevision: approval.revision, state, checker,
      result, resultDigest: digestAdminValue(result),
    });
    if (!changed) throw new Error("ADMIN_APPROVAL_CONCURRENT_DECISION");
  }

  private complete(
    transaction: PlatformTransaction,
    identity: CommandIdentity,
    state: "succeeded" | "failed",
    result: JsonValue,
  ): Promise<CommandReceipt> {
    return this.dependencies.receipts.recordOutcome(transaction, identity, {
      state, result, resultDigest: digestAdminValue(result),
    });
  }

  private event(
    transaction: PlatformTransaction,
    input: Readonly<{ context: VerifiedRequestSecurityContext; commandId: string; approvalRef: string }>,
    admission: AdminApprovalAdmission,
    eventType: string,
    outcome: JsonValue,
  ): Promise<void> {
    const payload = json({
      approvalRef: admission.approvalRef, originatingCommandId: admission.commandId,
      executionCommandId: input.commandId, checkerRef: admission.checkerRef,
      checkerGeneration: admission.checkerGeneration.toString(),
      checkerAuthorizationEpoch: admission.checkerAuthorizationEpoch.toString(),
      makerRef: admission.makerRef, makerGeneration: admission.makerGeneration.toString(),
      makerAuthorizationEpoch: admission.makerAuthorizationEpoch.toString(),
      siteRef: admission.siteRef, environment: admission.environment, region: admission.region,
      decision: admission.decision, outcome,
    });
    const event: OutboxEvent = {
      eventId: this.dependencies.reference(), owner: "admin-control", eventType,
      aggregateId: input.approvalRef, payload, payloadDigest: digestAdminValue(payload),
      correlationId: input.context.correlationId, causationId: input.context.requestId,
    };
    return this.dependencies.outbox.enqueue(transaction, event);
  }

  private now(): string {
    return (this.dependencies.clock ?? (() => new Date()))().toISOString();
  }
}

function restore(receipt: CommandReceipt): AdminApprovalSubmissionResult {
  const result = receipt.result;
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("ADMIN_APPROVAL_RECEIPT_INVALID");
  }
  const value = result as Record<string, JsonValue>;
  if (
    !["executed", "rejected", "effect_rejected", "denied"].includes(String(value.disposition)) ||
    typeof value.commandId !== "string" || typeof value.approvalRef !== "string"
  ) throw new Error("ADMIN_APPROVAL_RECEIPT_INVALID");
  return Object.freeze(value) as AdminApprovalSubmissionResult;
}

function safeCode(error: unknown): string {
  const value = error instanceof Error ? error.message : "ADMIN_APPROVAL_DENIED";
  return /^ADMIN_[A-Z0-9_]{1,120}$/u.test(value) ? value : "ADMIN_APPROVAL_DENIED";
}

function epoch(value: string): bigint {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error("ADMIN_OPERATOR_GENERATION_INVALID");
  return BigInt(value);
}

function bounded(value: string, code: string): void {
  if (value.length < 8 || value.length > 128 || Array.from(value).some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point < 32 || point === 127;
  })) throw new Error(code);
}

function json(value: Readonly<Record<string, JsonValue>>): JsonValue {
  return Object.freeze({ ...value });
}
