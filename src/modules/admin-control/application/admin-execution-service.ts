import type { ClaimedOutboxEvent } from "../../../shared/outbox-inbox/outbox.js";
import type { JsonValue } from "../../../shared/outbox-inbox/receipt.js";
import type { PlatformTransaction } from "../../../shared/unit-of-work/index.js";
import { digestAdminValue } from "./admin-digest.js";
import type { AdminLocalCommandRegistry } from "./admin-command-service.js";
import type { AdminApprovalRecord } from "../domain/admin-approval.js";
import type { AdminOperatorAuthority } from "../domain/admin-command.js";

export interface AdminExecutionRepositoryPort {
  lockApproval(transaction: PlatformTransaction, approvalRef: string): Promise<AdminApprovalRecord | null>;
  lockOperatorAuthority(
    transaction: PlatformTransaction,
    input: Readonly<{ operatorRef: string; operatorGeneration: bigint }>,
  ): Promise<AdminOperatorAuthority | null>;
  completeExecution(
    transaction: PlatformTransaction,
    input: Readonly<{
      approvalRef: string;
      expectedRevision: bigint;
      state: "executed" | "effect_rejected" | "stale_authority";
      result: JsonValue;
      resultDigest: string;
      code: string | null;
    }>,
  ): Promise<boolean>;
}

export interface AdminExecutionOutboxPort {
  complete(transaction: PlatformTransaction, eventId: string, leaseToken: string): Promise<void>;
}

export class AdminExecutionService {
  constructor(private readonly dependencies: Readonly<{
    registry: AdminLocalCommandRegistry;
    repository: AdminExecutionRepositoryPort;
    outbox: AdminExecutionOutboxPort;
    clock?: () => Date;
  }>) {}

  async executeClaim(transaction: PlatformTransaction, event: ClaimedOutboxEvent): Promise<void> {
    const envelope = parseEnvelope(event);
    const approval = await this.dependencies.repository.lockApproval(transaction, envelope.approvalRef);
    if (
      approval === null || approval.state !== "execution_queued" || approval.checker === null ||
      approval.payloadDigest !== digestAdminValue(approval.payload) ||
      !matches(envelope, approval)
    ) throw new Error("ADMIN_EXECUTION_ENVELOPE_INVALID");
    const handler = this.dependencies.registry.require(envelope.ownerOperation);
    if (
      handler.definition.effectClass !== "dangerous" ||
      handler.definition.approvalPolicy !== "pre_effect"
    ) throw new Error("ADMIN_EXECUTION_HANDLER_INVALID");
    const authorities = await this.authorities(transaction, approval);
    if (!authoritiesCurrent(approval, handler.definition.permission, authorities, this.now())) {
      await this.terminal(transaction, approval, "stale_authority",
        { code: "ADMIN_EXECUTION_AUTHORITY_STALE" }, "ADMIN_EXECUTION_AUTHORITY_STALE");
      await this.dependencies.outbox.complete(transaction, event.eventId, event.leaseToken);
      return;
    }
    const outcome = await handler.execute(transaction, {
      admission: approval.admission,
      approval: approval.checker,
      payload: approval.payload,
      requestDigest: approval.requestDigest,
    });
    if (outcome.disposition === "rejected") {
      await this.terminal(transaction, approval, "effect_rejected", outcome.result, outcome.code);
    } else {
      await this.terminal(transaction, approval, "executed", outcome.result, null);
    }
    await this.dependencies.outbox.complete(transaction, event.eventId, event.leaseToken);
  }

  private async authorities(transaction: PlatformTransaction, approval: AdminApprovalRecord) {
    const identities = [
      { operatorRef: approval.admission.operatorRef, operatorGeneration: approval.admission.operatorGeneration },
      { operatorRef: approval.checker!.checkerRef, operatorGeneration: approval.checker!.checkerGeneration },
    ].sort((left, right) => left.operatorRef.localeCompare(right.operatorRef));
    const values = new Map<string, AdminOperatorAuthority | null>();
    for (const identity of identities) {
      values.set(identity.operatorRef,
        await this.dependencies.repository.lockOperatorAuthority(transaction, identity));
    }
    return Object.freeze({
      maker: values.get(approval.admission.operatorRef) ?? null,
      checker: values.get(approval.checker!.checkerRef) ?? null,
    });
  }

  private async terminal(
    transaction: PlatformTransaction,
    approval: AdminApprovalRecord,
    state: "executed" | "effect_rejected" | "stale_authority",
    result: JsonValue,
    code: string | null,
  ): Promise<void> {
    const changed = await this.dependencies.repository.completeExecution(transaction, {
      approvalRef: approval.approvalRef,
      expectedRevision: approval.revision,
      state,
      result,
      resultDigest: digestAdminValue(result),
      code,
    });
    if (!changed) throw new Error("ADMIN_EXECUTION_CONCURRENT_TRANSITION");
  }

  private now(): string {
    return (this.dependencies.clock ?? (() => new Date()))().toISOString();
  }
}

type ExecutionEnvelope = Readonly<{
  approvalRef: string;
  originatingCommandId: string;
  ownerOperation: string;
  makerRef: string;
  makerGeneration: bigint;
  makerAuthorizationEpoch: bigint;
  checkerRef: string;
  checkerGeneration: bigint;
  checkerAuthorizationEpoch: bigint;
  siteRef: string | null;
  environment: string;
  region: string;
}>;

function parseEnvelope(event: ClaimedOutboxEvent): ExecutionEnvelope {
  if (
    event.owner !== "admin-execution" ||
    event.eventType !== "admin.approval.execution.requested" ||
    event.payloadDigest !== digestAdminValue(event.payload) ||
    event.payload === null || typeof event.payload !== "object" || Array.isArray(event.payload)
  ) throw new Error("ADMIN_EXECUTION_ENVELOPE_INVALID");
  const value = event.payload as Record<string, JsonValue>;
  const text = (name: string): string => {
    const child = value[name];
    if (typeof child !== "string" || child.length < 3 || child.length > 128) {
      throw new Error("ADMIN_EXECUTION_ENVELOPE_INVALID");
    }
    return child;
  };
  const epoch = (name: string): bigint => {
    const child = value[name];
    if (typeof child !== "string" || !/^[1-9][0-9]{0,19}$/u.test(child)) {
      throw new Error("ADMIN_EXECUTION_ENVELOPE_INVALID");
    }
    return BigInt(child);
  };
  const siteRef = value.siteRef;
  if (siteRef !== null && typeof siteRef !== "string") throw new Error("ADMIN_EXECUTION_ENVELOPE_INVALID");
  return Object.freeze({
    approvalRef: text("approvalRef"),
    originatingCommandId: text("originatingCommandId"),
    ownerOperation: text("ownerOperation"),
    makerRef: text("makerRef"), makerGeneration: epoch("makerGeneration"),
    makerAuthorizationEpoch: epoch("makerAuthorizationEpoch"),
    checkerRef: text("checkerRef"), checkerGeneration: epoch("checkerGeneration"),
    checkerAuthorizationEpoch: epoch("checkerAuthorizationEpoch"),
    siteRef: siteRef as string | null,
    environment: text("environment"), region: text("region"),
  });
}

function matches(event: ExecutionEnvelope, approval: AdminApprovalRecord): boolean {
  const checker = approval.checker!;
  return event.approvalRef === approval.approvalRef &&
    event.originatingCommandId === approval.commandId &&
    event.ownerOperation === approval.admission.commandId &&
    event.makerRef === approval.admission.operatorRef &&
    event.makerGeneration === approval.admission.operatorGeneration &&
    event.makerAuthorizationEpoch === approval.admission.authorizationEpoch &&
    event.checkerRef === checker.checkerRef && event.checkerGeneration === checker.checkerGeneration &&
    event.checkerAuthorizationEpoch === checker.checkerAuthorizationEpoch &&
    event.siteRef === approval.admission.siteRef && event.environment === approval.admission.environment &&
    event.region === approval.admission.region;
}

function authoritiesCurrent(
  approval: AdminApprovalRecord,
  permission: string,
  authorities: Readonly<{ maker: AdminOperatorAuthority | null; checker: AdminOperatorAuthority | null }>,
  now: string,
): boolean {
  const checkerEvidence = approval.checker!;
  const current = (authority: AdminOperatorAuthority | null): authority is AdminOperatorAuthority =>
    authority !== null && authority.state === "active" && Date.parse(authority.expiresAt) > Date.parse(now) &&
    authority.environments.includes(approval.admission.environment) &&
    authority.regions.includes(approval.admission.region) && scoped(authority, approval.admission.siteRef);
  return current(authorities.maker) && current(authorities.checker) &&
    authorities.maker.operatorGeneration === approval.admission.operatorGeneration &&
    authorities.maker.authorizationEpoch === approval.admission.authorizationEpoch &&
    authorities.checker.operatorGeneration === checkerEvidence.checkerGeneration &&
    authorities.checker.authorizationEpoch === checkerEvidence.checkerAuthorizationEpoch &&
    permits(authorities.maker.permissions, permission) && permits(authorities.checker.permissions, permission) &&
    permits(authorities.checker.permissions, "admin.approval.execute");
}

function scoped(authority: AdminOperatorAuthority, siteRef: string | null): boolean {
  return siteRef === null
    ? authority.globalScopes.length > 0
    : authority.siteScopes.includes(siteRef);
}

function permits(grants: readonly string[], required: string): boolean {
  return grants.includes(required) || grants.some((grant) =>
    grant.endsWith(".*") && required.startsWith(grant.slice(0, -1)));
}
