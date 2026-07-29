import type { JsonValue, CommandIdentity, CommandReceipt } from "../../../shared/outbox-inbox/receipt.js";
import type { OutboxEvent } from "../../../shared/outbox-inbox/outbox.js";
import type { VerifiedRequestSecurityContext } from "../../../shared/security-context/index.js";
import type { PlatformTransaction } from "../../../shared/unit-of-work/index.js";
import { digestAdminValue } from "./admin-digest.js";
import {
  AdminCommandRegistry,
  admitAdminCommand,
  type AdminCommandAdmission,
  type AdminCommandDefinition,
  type AdminOperatorAuthority,
} from "../domain/admin-command.js";
import type { AdminApprovalAdmission } from "../domain/admin-approval.js";

export interface AdminUnitOfWorkPort {
  execute<Result>(
    fence: Readonly<{ context: VerifiedRequestSecurityContext; operation: string }>,
    work: (transaction: PlatformTransaction) => Promise<Result>,
  ): Promise<Result>;
}

export interface AdminReceiptPort {
  begin(transaction: PlatformTransaction, identity: CommandIdentity): Promise<CommandReceipt>;
  recordOutcome(
    transaction: PlatformTransaction,
    identity: CommandIdentity,
    outcome: Readonly<{ state: "succeeded" | "failed" | "outcome_unknown"; result: JsonValue | null; resultDigest: string }>,
  ): Promise<CommandReceipt>;
}

export interface AdminOutboxPort {
  enqueue(transaction: PlatformTransaction, event: OutboxEvent): Promise<void>;
}

export interface AdminAuthorityRepositoryPort {
  lockOperatorAuthority(
    transaction: PlatformTransaction,
    input: Readonly<{ operatorRef: string; operatorGeneration: bigint }>,
  ): Promise<AdminOperatorAuthority | null>;
  recordDecision(
    transaction: PlatformTransaction,
    decision: AdminDecisionRecord,
  ): Promise<void>;
  createApproval(
    transaction: PlatformTransaction,
    input: Readonly<{
      approvalRef: string;
      commandId: string;
      requestDigest: string;
      payload: JsonValue;
      payloadDigest: string;
      admission: AdminCommandAdmission;
      expiresAt: string;
    }>,
  ): Promise<void>;
  createPostEffectReview(
    transaction: PlatformTransaction,
    input: Readonly<{
      reviewRef: string;
      commandId: string;
      requestDigest: string;
      operation: string;
      admission: AdminCommandAdmission;
      breakGlassTicketRef: string;
      outcome: JsonValue;
      outcomeDigest: string;
      expiresAt: string;
    }>,
  ): Promise<void>;
}

export interface AdminDecisionRecord {
  readonly decisionRef: string;
  readonly commandId: string;
  readonly requestDigest: string;
  readonly operatorRef: string;
  readonly operatorGeneration: bigint;
  readonly operation: string;
  readonly targetSiteRef: string | null;
  readonly environment: string;
  readonly region: string;
  readonly allowed: boolean;
  readonly reasonCode: string;
  readonly effectClass: string;
  readonly approvalPolicy: string;
  readonly operatorReason: string | null;
  readonly breakGlassTicketRef: string | null;
  readonly authorizationEpoch: bigint | null;
  readonly occurredAt: string;
}

export type AdminHandlerResult =
  | Readonly<{ disposition: "succeeded"; result: JsonValue }>
  | Readonly<{ disposition: "rejected"; code: string; result: JsonValue }>;

export interface AdminLocalCommandHandler {
  readonly definition: AdminCommandDefinition;
  execute(
    transaction: PlatformTransaction,
    input: Readonly<{
      admission: AdminCommandAdmission;
      approval?: AdminApprovalAdmission;
      payload: JsonValue;
      requestDigest: string;
    }>,
  ): Promise<AdminHandlerResult>;
}

export class AdminLocalCommandRegistry {
  readonly definitions: AdminCommandRegistry;
  readonly #handlers: ReadonlyMap<string, AdminLocalCommandHandler>;

  constructor(handlers: readonly AdminLocalCommandHandler[]) {
    this.definitions = new AdminCommandRegistry(handlers.map((handler) => handler.definition));
    this.#handlers = new Map(handlers.map((handler) => [handler.definition.commandId, handler]));
  }

  require(commandId: string): AdminLocalCommandHandler {
    this.definitions.require(commandId);
    const handler = this.#handlers.get(commandId);
    if (!handler) throw new Error("ADMIN_COMMAND_HANDLER_MISSING");
    return handler;
  }
}

export type AdminCommandSubmissionResult =
  | Readonly<{ disposition: "pending_approval"; approvalRef: string; commandId: string }>
  | Readonly<{ disposition: "succeeded"; commandId: string; result: JsonValue }>
  | Readonly<{ disposition: "review_required"; reviewRef: string; commandId: string; result: JsonValue }>
  | Readonly<{ disposition: "denied" | "rejected"; commandId: string; code: string }>;

export class AdminCommandService {
  constructor(private readonly dependencies: Readonly<{
    unitOfWork: AdminUnitOfWorkPort;
    registry: AdminLocalCommandRegistry;
    repository: AdminAuthorityRepositoryPort;
    receipts: AdminReceiptPort;
    outbox: AdminOutboxPort;
    clock?: () => Date;
    approvalTtlMs?: number;
    reference: () => string;
  }>) {}

  async submit(input: Readonly<{
    context: VerifiedRequestSecurityContext;
    commandId: string;
    idempotencyKey: string;
    operation: string;
    targetSiteRef: string | null;
    reason: string | null;
    breakGlassTicketRef: string | null;
    payload: JsonValue;
  }>): Promise<AdminCommandSubmissionResult> {
    const handler = this.dependencies.registry.require(input.operation);
    bounded(input.idempotencyKey, 8, 128, "ADMIN_IDEMPOTENCY_KEY_INVALID");
    const payloadDigest = digestAdminValue(input.payload);
    const requestDigest = digestAdminValue({
      commandId: input.commandId,
      operation: input.operation,
      targetSiteRef: input.targetSiteRef,
      reason: input.reason,
      breakGlassTicketRef: input.breakGlassTicketRef,
      payloadDigest,
      operatorRef: input.context.actor.subjectId,
      operatorGeneration: input.context.actor.subjectGeneration,
      environment: input.context.environment,
      region: input.context.region,
    });
    const identity = Object.freeze({
      commandId: input.commandId,
      environment: input.context.environment,
      region: input.context.region,
      callerIdentity: `${input.context.trustedCaller.workloadIdentityId}:${input.context.actor.subjectId}:${input.context.actor.subjectGeneration}`,
      operation: input.operation,
      idempotencyKey: input.idempotencyKey,
      requestDigest,
    });
    return this.dependencies.unitOfWork.execute(
      { context: input.context, operation: input.operation },
      async (transaction) => {
        let existing: CommandReceipt;
        try {
          existing = await this.dependencies.receipts.begin(transaction, identity);
        } catch (error) {
          if (error instanceof Error && error.message === "COMMAND_DIGEST_CONFLICT") {
            return this.denied(transaction, input, identity, requestDigest, handler.definition,
              null, "ADMIN_IDEMPOTENCY_CONFLICT", false);
          }
          throw error;
        }
        if (existing.commandId !== input.commandId) return this.denied(transaction, input, identity,
          requestDigest, handler.definition, null, "ADMIN_COMMAND_ID_CONFLICT", false);
        if (existing.state === "succeeded" || existing.state === "failed") return restore(existing);
        const operatorGeneration = bigint(input.context.actor.subjectGeneration, "ADMIN_OPERATOR_GENERATION_INVALID");
        const authority = await this.dependencies.repository.lockOperatorAuthority(transaction, {
          operatorRef: input.context.actor.subjectId,
          operatorGeneration,
        });
        if (authority === null) return this.denied(transaction, input, identity,
          requestDigest, handler.definition, null, "ADMIN_OPERATOR_AUTHORITY_NOT_FOUND", true);
        let admission: AdminCommandAdmission;
        try {
          admission = admitAdminCommand({ definition: handler.definition, context: input.context,
            authority, targetSiteRef: input.targetSiteRef, reason: input.reason,
            breakGlassTicketRef: input.breakGlassTicketRef, now: this.now() });
        } catch (error) {
          return this.denied(transaction, input, identity, requestDigest, handler.definition,
            authority.authorizationEpoch, safeCode(error), true);
        }
        await this.dependencies.repository.recordDecision(transaction, {
          decisionRef: this.dependencies.reference(), commandId: input.commandId, requestDigest,
          operatorRef: admission.operatorRef, operatorGeneration: admission.operatorGeneration,
          operation: admission.commandId, targetSiteRef: admission.siteRef,
          environment: admission.environment, region: admission.region, allowed: true,
          reasonCode: "ALLOW", effectClass: admission.effectClass,
          approvalPolicy: admission.approvalPolicy, operatorReason: admission.reason,
          breakGlassTicketRef: admission.breakGlassTicketRef,
          authorizationEpoch: admission.authorizationEpoch, occurredAt: admission.admittedAt,
        });
        if (admission.approvalPolicy === "pre_effect") {
          const approvalRef = this.dependencies.reference();
          await this.dependencies.repository.createApproval(transaction, {
            approvalRef, commandId: input.commandId, requestDigest, payload: input.payload,
            payloadDigest, admission, expiresAt: this.approvalExpiry(admission.admittedAt),
          });
          const result = json({ disposition: "pending_approval", approvalRef, commandId: input.commandId });
          await this.success(transaction, identity, result);
          await this.event(transaction, input, admission, requestDigest, "admin.command.approval.requested", result);
          return Object.freeze({ disposition: "pending_approval", approvalRef, commandId: input.commandId });
        }
        const outcome = await handler.execute(transaction, { admission, payload: input.payload, requestDigest });
        if (outcome.disposition === "rejected") {
          const result = json({ disposition: "rejected", commandId: input.commandId, code: outcome.code });
          await this.dependencies.receipts.recordOutcome(transaction, identity, {
            state: "failed", result, resultDigest: digestAdminValue(result),
          });
          await this.event(transaction, input, admission, requestDigest, "admin.command.rejected", result);
          return Object.freeze({ disposition: "rejected", commandId: input.commandId, code: outcome.code });
        }
        const reviewRef = admission.approvalPolicy === "post_effect_review"
          ? this.dependencies.reference()
          : null;
        if (reviewRef !== null) {
          if (admission.breakGlassTicketRef === null) throw new Error("ADMIN_BREAK_GLASS_TICKET_REQUIRED");
          await this.dependencies.repository.createPostEffectReview(transaction, {
            reviewRef, commandId: input.commandId, requestDigest, operation: admission.commandId,
            admission, breakGlassTicketRef: admission.breakGlassTicketRef,
            outcome: outcome.result, outcomeDigest: digestAdminValue(outcome.result),
            expiresAt: this.postEffectReviewExpiry(admission.admittedAt),
          });
        }
        const disposition = reviewRef === null ? "succeeded" : "review_required";
        const result = json({ disposition, commandId: input.commandId, result: outcome.result,
          ...(reviewRef === null ? {} : { reviewRef }) });
        await this.success(transaction, identity, result);
        await this.event(transaction, input, admission, requestDigest,
          disposition === "review_required" ? "admin.command.break-glass.executed" : "admin.command.succeeded", result);
        return reviewRef === null
          ? Object.freeze({ disposition: "succeeded" as const, commandId: input.commandId,
            result: outcome.result })
          : Object.freeze({ disposition: "review_required" as const, reviewRef,
            commandId: input.commandId, result: outcome.result });
      },
    );
  }

  private async denied(
    transaction: PlatformTransaction,
    input: Readonly<{ commandId: string; operation: string; targetSiteRef: string | null; context: VerifiedRequestSecurityContext }>,
    identity: CommandIdentity,
    requestDigest: string,
    definition: AdminCommandDefinition,
    authorizationEpoch: bigint | null,
    code: string,
    recordReceipt: boolean,
  ): Promise<AdminCommandSubmissionResult> {
    await this.dependencies.repository.recordDecision(transaction, {
      decisionRef: this.dependencies.reference(), commandId: input.commandId, requestDigest,
      operatorRef: input.context.actor.subjectId,
      operatorGeneration: BigInt(input.context.actor.subjectGeneration), operation: input.operation,
      targetSiteRef: input.targetSiteRef, environment: input.context.environment,
      region: input.context.region, allowed: false, reasonCode: code,
      effectClass: definition.effectClass, approvalPolicy: definition.approvalPolicy,
      operatorReason: null, breakGlassTicketRef: null, authorizationEpoch, occurredAt: this.now(),
    });
    const result = json({ disposition: "denied", commandId: input.commandId, code });
    if (recordReceipt) {
      await this.dependencies.receipts.recordOutcome(transaction, identity, {
        state: "failed", result, resultDigest: digestAdminValue(result),
      });
    }
    return Object.freeze({ disposition: "denied", commandId: input.commandId, code });
  }

  private async success(transaction: PlatformTransaction, identity: CommandIdentity, result: JsonValue): Promise<void> {
    await this.dependencies.receipts.recordOutcome(transaction, identity, {
      state: "succeeded", result, resultDigest: digestAdminValue(result),
    });
  }

  private event(
    transaction: PlatformTransaction,
    input: Readonly<{ commandId: string; context: VerifiedRequestSecurityContext }>,
    admission: AdminCommandAdmission,
    requestDigest: string,
    eventType: string,
    payload: JsonValue,
  ): Promise<void> {
    const eventPayload = json({
      commandId: input.commandId,
      operation: admission.commandId,
      operatorRef: admission.operatorRef,
      operatorGeneration: admission.operatorGeneration.toString(),
      authorizationEpoch: admission.authorizationEpoch.toString(),
      targetSiteRef: admission.siteRef,
      environment: admission.environment,
      region: admission.region,
      effectClass: admission.effectClass,
      approvalPolicy: admission.approvalPolicy,
      requestDigest,
      outcome: payload,
    });
    const event: OutboxEvent = {
      eventId: this.dependencies.reference(), owner: "admin-control", eventType,
      aggregateId: input.commandId, payload: eventPayload, payloadDigest: digestAdminValue(eventPayload),
      correlationId: input.context.correlationId, causationId: input.context.requestId,
    };
    return this.dependencies.outbox.enqueue(transaction, event);
  }

  private now(): string {
    return (this.dependencies.clock ?? (() => new Date()))().toISOString();
  }

  private approvalExpiry(admittedAt: string): string {
    const ttl = this.dependencies.approvalTtlMs ?? 15 * 60_000;
    if (!Number.isInteger(ttl) || ttl < 60_000 || ttl > 60 * 60_000) {
      throw new Error("ADMIN_APPROVAL_TTL_INVALID");
    }
    return new Date(Date.parse(admittedAt) + ttl).toISOString();
  }

  private postEffectReviewExpiry(admittedAt: string): string {
    return new Date(Date.parse(admittedAt) + 24 * 60 * 60_000).toISOString();
  }
}

function restore(receipt: CommandReceipt): AdminCommandSubmissionResult {
  const result = receipt.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("ADMIN_COMMAND_RECEIPT_INVALID");
  const value = result as Record<string, JsonValue>;
  if (typeof value.disposition !== "string" || typeof value.commandId !== "string") {
    throw new Error("ADMIN_COMMAND_RECEIPT_INVALID");
  }
  if (value.disposition === "pending_approval" && typeof value.approvalRef === "string") {
    return Object.freeze({ disposition: "pending_approval", approvalRef: value.approvalRef, commandId: value.commandId });
  }
  if ((value.disposition === "denied" || value.disposition === "rejected") && typeof value.code === "string") {
    return Object.freeze({ disposition: value.disposition, commandId: value.commandId, code: value.code });
  }
  if (value.disposition === "succeeded" && "result" in value) {
    return Object.freeze({ disposition: value.disposition, commandId: value.commandId, result: value.result });
  }
  if (value.disposition === "review_required" && "result" in value && typeof value.reviewRef === "string") {
    return Object.freeze({ disposition: value.disposition, reviewRef: value.reviewRef,
      commandId: value.commandId, result: value.result });
  }
  throw new Error("ADMIN_COMMAND_RECEIPT_INVALID");
}

function safeCode(error: unknown): string {
  const value = error instanceof Error ? error.message : "ADMIN_ADMISSION_DENIED";
  return /^ADMIN_[A-Z0-9_]{1,120}$/u.test(value) ? value : "ADMIN_ADMISSION_DENIED";
}

function bigint(value: string, code: string): bigint {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(code);
  return BigInt(value);
}

function json(value: Readonly<Record<string, JsonValue>>): JsonValue {
  return Object.freeze({ ...value });
}

function bounded(value: string, minimum: number, maximum: number, code: string): void {
  if (value.length < minimum || value.length > maximum) throw new Error(code);
}
