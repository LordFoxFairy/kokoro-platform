import type { JsonValue } from "../../../shared/outbox-inbox/receipt.js";
import type { VerifiedRequestSecurityContext } from "../../../shared/security-context/index.js";
import type {
  AdminCommandAdmission,
  AdminCommandDefinition,
  AdminOperatorAuthority,
} from "./admin-command.js";

export type AdminApprovalState = "pending" | "executed" | "rejected" | "effect_rejected" | "expired";

export interface AdminApprovalRecord {
  readonly approvalRef: string;
  readonly commandId: string;
  readonly requestDigest: string;
  readonly payload: JsonValue;
  readonly payloadDigest: string;
  readonly admission: AdminCommandAdmission;
  readonly state: AdminApprovalState;
  readonly revision: bigint;
  readonly expiresAt: string;
}

export interface AdminApprovalAdmission {
  readonly approvalRef: string;
  readonly commandId: string;
  readonly checkerRef: string;
  readonly checkerGeneration: bigint;
  readonly checkerAuthorizationEpoch: bigint;
  readonly makerRef: string;
  readonly makerGeneration: bigint;
  readonly makerAuthorizationEpoch: bigint;
  readonly siteRef: string | null;
  readonly environment: string;
  readonly region: string;
  readonly decision: "approve" | "reject";
  readonly reason: string;
  readonly admittedAt: string;
}

export function admitAdminApproval(input: Readonly<{
  approval: AdminApprovalRecord;
  definition: AdminCommandDefinition;
  context: VerifiedRequestSecurityContext;
  makerAuthority: AdminOperatorAuthority;
  checkerAuthority: AdminOperatorAuthority;
  decision: "approve" | "reject";
  reason: string;
  now: string;
}>): AdminApprovalAdmission {
  const { approval, definition, context, makerAuthority, checkerAuthority } = input;
  const now = instant(input.now);
  if (approval.state !== "pending") throw new Error("ADMIN_APPROVAL_TERMINAL");
  if (Date.parse(approval.expiresAt) <= Date.parse(now)) throw new Error("ADMIN_APPROVAL_EXPIRED");
  if (
    definition.commandId !== approval.admission.commandId ||
    definition.effectClass !== "dangerous" ||
    definition.approvalPolicy !== "pre_effect"
  ) throw new Error("ADMIN_APPROVAL_COMMAND_INVALID");
  if (
    context.trustedCaller.kind !== "admin_workload" ||
    context.actor.kind !== "operator" ||
    context.target.purpose !== "admin.approval.execute" ||
    !context.trustedCaller.allowedOperations.includes("admin.approval.execute") ||
    context.environment !== approval.admission.environment ||
    context.region !== approval.admission.region ||
    context.environment !== context.trustedCaller.environment ||
    context.region !== context.trustedCaller.region
  ) throw new Error("ADMIN_APPROVAL_CONTEXT_INVALID");
  current(makerAuthority, now);
  current(checkerAuthority, now);
  if (
    makerAuthority.operatorRef !== approval.admission.operatorRef ||
    makerAuthority.operatorGeneration !== approval.admission.operatorGeneration ||
    makerAuthority.authorizationEpoch !== approval.admission.authorizationEpoch ||
    !makerAuthority.environments.includes(approval.admission.environment) ||
    !makerAuthority.regions.includes(approval.admission.region) ||
    !permits(makerAuthority.permissions, definition.permission) ||
    !scoped(makerAuthority, approval.admission.siteRef)
  ) throw new Error("ADMIN_MAKER_AUTHORITY_STALE");
  if (
    checkerAuthority.operatorRef !== context.actor.subjectId ||
    checkerAuthority.operatorGeneration.toString() !== context.actor.subjectGeneration ||
    checkerAuthority.operatorRef === makerAuthority.operatorRef ||
    !permits(checkerAuthority.permissions, "admin.approval.execute") ||
    !permits(checkerAuthority.permissions, definition.permission) ||
    !scoped(checkerAuthority, approval.admission.siteRef) ||
    !checkerAuthority.environments.includes(context.environment) ||
    !checkerAuthority.regions.includes(context.region)
  ) throw new Error("ADMIN_CHECKER_AUTHORITY_INVALID");
  if (
    context.actor.assuranceLevel !== "phishing_resistant" ||
    context.actor.stepUpAt === undefined || context.actor.stepUpAt === null ||
    Date.parse(context.actor.stepUpAt) > Date.parse(now) ||
    Date.parse(now) - Date.parse(context.actor.stepUpAt) > 5 * 60_000
  ) throw new Error("ADMIN_APPROVAL_STEP_UP_REQUIRED");
  if (approval.admission.siteRef === null) {
    if (context.target.siteId !== null) throw new Error("ADMIN_APPROVAL_SCOPE_INVALID");
  } else if (context.target.siteId !== approval.admission.siteRef) {
    throw new Error("ADMIN_APPROVAL_SCOPE_INVALID");
  }
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 1024 || control(reason)) {
    throw new Error("ADMIN_APPROVAL_REASON_INVALID");
  }
  return Object.freeze({
    approvalRef: approval.approvalRef,
    commandId: approval.commandId,
    checkerRef: checkerAuthority.operatorRef,
    checkerGeneration: checkerAuthority.operatorGeneration,
    checkerAuthorizationEpoch: checkerAuthority.authorizationEpoch,
    makerRef: makerAuthority.operatorRef,
    makerGeneration: makerAuthority.operatorGeneration,
    makerAuthorizationEpoch: makerAuthority.authorizationEpoch,
    siteRef: approval.admission.siteRef,
    environment: approval.admission.environment,
    region: approval.admission.region,
    decision: input.decision,
    reason,
    admittedAt: now,
  });
}

function current(authority: AdminOperatorAuthority, now: string): void {
  if (
    authority.state !== "active" || authority.operatorGeneration < 1n ||
    authority.authorizationEpoch < 1n || Date.parse(authority.expiresAt) <= Date.parse(now)
  ) throw new Error("ADMIN_OPERATOR_AUTHORITY_INVALID");
}

function scoped(authority: AdminOperatorAuthority, siteRef: string | null): boolean {
  if (siteRef === null) return authority.siteScopes.includes("*");
  return authority.siteScopes.includes("*") || authority.siteScopes.includes(siteRef);
}

function permits(grants: readonly string[], required: string): boolean {
  return grants.includes(required) || grants.some((grant) =>
    grant.endsWith(".*") && required.startsWith(grant.slice(0, -1)));
}

function instant(value: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error("ADMIN_TIME_INVALID");
  return new Date(value).toISOString();
}

function control(value: string): boolean {
  return Array.from(value).some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point < 32 || point === 127;
  });
}
