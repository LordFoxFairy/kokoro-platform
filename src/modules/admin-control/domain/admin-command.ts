import type { VerifiedRequestSecurityContext } from "../../../shared/security-context/index.js";

export type AdminEffectClass = "read" | "mutation" | "dangerous" | "break_glass";
export type AdminScopeKind = "site" | "global";
export type AdminApprovalPolicy = "none" | "pre_effect" | "post_effect_review";

export interface AdminCommandDefinition<CommandId extends string = string> {
  readonly commandId: CommandId;
  readonly permission: string;
  readonly effectClass: AdminEffectClass;
  readonly scopeKind: AdminScopeKind;
  readonly approvalPolicy: AdminApprovalPolicy;
  readonly reasonRequired: boolean;
}

export interface AdminOperatorAuthority {
  readonly operatorRef: string;
  readonly operatorGeneration: bigint;
  readonly state: "active" | "suspended" | "revoked";
  readonly permissions: readonly string[];
  readonly siteScopes: readonly string[];
  readonly globalScopes: readonly string[];
  readonly environments: readonly string[];
  readonly regions: readonly string[];
  readonly authorizationEpoch: bigint;
  readonly expiresAt: string;
  readonly breakGlassExpiresAt: string | null;
}

export interface AdminCommandAdmission {
  readonly commandId: string;
  readonly operatorRef: string;
  readonly operatorGeneration: bigint;
  readonly authorizationEpoch: bigint;
  readonly siteRef: string | null;
  readonly environment: string;
  readonly region: string;
  readonly effectClass: AdminEffectClass;
  readonly approvalPolicy: AdminApprovalPolicy;
  readonly reason: string | null;
  readonly breakGlassTicketRef: string | null;
  readonly admittedAt: string;
}

export function defineAdminCommand<const CommandId extends string>(
  value: AdminCommandDefinition<CommandId>,
): AdminCommandDefinition<CommandId> {
  identifier(value.commandId, "ADMIN_COMMAND_ID_INVALID");
  permission(value.permission);
  if (value.effectClass === "read" && value.approvalPolicy !== "none") {
    throw new Error("ADMIN_READ_APPROVAL_INVALID");
  }
  if (value.effectClass === "dangerous" && value.approvalPolicy !== "pre_effect") {
    throw new Error("ADMIN_DANGEROUS_APPROVAL_REQUIRED");
  }
  if (value.effectClass === "break_glass" && value.approvalPolicy !== "post_effect_review") {
    throw new Error("ADMIN_BREAK_GLASS_REVIEW_REQUIRED");
  }
  if (value.effectClass !== "read" && !value.reasonRequired) {
    throw new Error("ADMIN_MUTATION_REASON_REQUIRED");
  }
  return Object.freeze({ ...value });
}

export class AdminCommandRegistry {
  readonly #definitions: ReadonlyMap<string, AdminCommandDefinition>;

  constructor(definitions: readonly AdminCommandDefinition[]) {
    const values = new Map<string, AdminCommandDefinition>();
    for (const definition of definitions) {
      const verified = defineAdminCommand(definition);
      if (values.has(verified.commandId)) throw new Error("ADMIN_COMMAND_DUPLICATE");
      values.set(verified.commandId, verified);
    }
    if (values.size === 0) throw new Error("ADMIN_COMMAND_REGISTRY_EMPTY");
    this.#definitions = values;
  }

  require(commandId: string): AdminCommandDefinition {
    const definition = this.#definitions.get(commandId);
    if (!definition) throw new Error("ADMIN_COMMAND_NOT_REGISTERED");
    return definition;
  }

  manifest(): readonly AdminCommandDefinition[] {
    return Object.freeze([...this.#definitions.values()].sort((left, right) =>
      left.commandId.localeCompare(right.commandId)));
  }
}

export function admitAdminCommand(input: Readonly<{
  definition: AdminCommandDefinition;
  context: VerifiedRequestSecurityContext;
  authority: AdminOperatorAuthority;
  targetSiteRef: string | null;
  reason: string | null;
  breakGlassTicketRef: string | null;
  now: string;
}>): AdminCommandAdmission {
  const { definition, context, authority } = input;
  const now = instant(input.now, "ADMIN_TIME_INVALID");
  verifyAuthority(authority);
  if (
    context.trustedCaller.kind !== "admin_workload" || context.actor.kind !== "operator" ||
    context.actor.subjectId !== authority.operatorRef ||
    context.actor.subjectGeneration !== authority.operatorGeneration.toString() ||
    context.target.purpose !== definition.commandId ||
    !context.trustedCaller.allowedOperations.includes(definition.commandId) ||
    context.environment !== context.trustedCaller.environment || context.region !== context.trustedCaller.region ||
    !authority.environments.includes(context.environment) || !authority.regions.includes(context.region) ||
    authority.state !== "active" || Date.parse(authority.expiresAt) <= Date.parse(now)
  ) throw new Error("ADMIN_OPERATOR_AUTHORITY_INVALID");
  if (!permits(authority.permissions, definition.permission)) throw new Error("ADMIN_PERMISSION_DENIED");
  const targetSiteRef = scope(definition, context, authority, input.targetSiteRef);
  const reason = normalizeReason(input.reason, definition.reasonRequired);
  const stepUpAt = context.actor.stepUpAt;
  if (definition.effectClass !== "read") {
    if (stepUpAt === undefined || stepUpAt === null || Date.parse(stepUpAt) > Date.parse(now) ||
        Date.parse(now) - Date.parse(stepUpAt) > 5 * 60_000) {
      throw new Error("ADMIN_STEP_UP_REQUIRED");
    }
  }
  if ((definition.effectClass === "dangerous" || definition.effectClass === "break_glass") &&
      context.actor.assuranceLevel !== "phishing_resistant") {
    throw new Error("ADMIN_PHISHING_RESISTANT_REQUIRED");
  }
  let breakGlassTicketRef: string | null = null;
  if (definition.effectClass === "break_glass") {
    breakGlassTicketRef = normalizeReason(input.breakGlassTicketRef, true);
    if (
      !context.target.scopes.includes("admin:break-glass") || authority.breakGlassExpiresAt === null ||
      Date.parse(authority.breakGlassExpiresAt) <= Date.parse(now)
    ) throw new Error("ADMIN_BREAK_GLASS_AUTHORITY_REQUIRED");
  } else if (input.breakGlassTicketRef !== null) {
    throw new Error("ADMIN_BREAK_GLASS_TICKET_UNEXPECTED");
  }
  return Object.freeze({
    commandId: definition.commandId,
    operatorRef: authority.operatorRef,
    operatorGeneration: authority.operatorGeneration,
    authorizationEpoch: authority.authorizationEpoch,
    siteRef: targetSiteRef,
    environment: context.environment,
    region: context.region,
    effectClass: definition.effectClass,
    approvalPolicy: definition.approvalPolicy,
    reason,
    breakGlassTicketRef,
    admittedAt: now,
  });
}

function scope(
  definition: AdminCommandDefinition,
  context: VerifiedRequestSecurityContext,
  authority: AdminOperatorAuthority,
  targetSiteRef: string | null,
): string | null {
  if (definition.scopeKind === "global") {
    if (targetSiteRef !== null || context.target.siteId !== null || authority.globalScopes.length < 1) {
      throw new Error("ADMIN_GLOBAL_SCOPE_DENIED");
    }
    return null;
  }
  if (targetSiteRef === null || context.target.siteId !== targetSiteRef ||
      !authority.siteScopes.includes(targetSiteRef)) {
    throw new Error("ADMIN_SITE_SCOPE_DENIED");
  }
  return targetSiteRef;
}

function verifyAuthority(value: AdminOperatorAuthority): void {
  identifier(value.operatorRef, "ADMIN_OPERATOR_REF_INVALID");
  if (value.operatorGeneration < 1n || value.authorizationEpoch < 1n) throw new Error("ADMIN_OPERATOR_EPOCH_INVALID");
  if (value.permissions.length < 1 || value.environments.length < 1 || value.regions.length < 1 ||
      new Set(value.permissions).size !== value.permissions.length ||
      new Set(value.siteScopes).size !== value.siteScopes.length ||
      new Set(value.globalScopes).size !== value.globalScopes.length ||
      new Set(value.environments).size !== value.environments.length ||
      new Set(value.regions).size !== value.regions.length) throw new Error("ADMIN_OPERATOR_AUTHORITY_INVALID");
  value.permissions.forEach(permission);
  instant(value.expiresAt, "ADMIN_OPERATOR_EXPIRY_INVALID");
  if (value.breakGlassExpiresAt !== null) instant(value.breakGlassExpiresAt, "ADMIN_BREAK_GLASS_EXPIRY_INVALID");
}

function permits(grants: readonly string[], required: string): boolean {
  return grants.includes(required) || grants.some((grant) =>
    grant.endsWith(".*") && required.startsWith(grant.slice(0, -1)));
}

function normalizeReason(value: string | null, required: boolean): string | null {
  const result = value?.trim() ?? "";
  if (result.length === 0) {
    if (required) throw new Error("ADMIN_REASON_REQUIRED");
    return null;
  }
  if (result.length > 1024 || control(result)) throw new Error("ADMIN_REASON_INVALID");
  return result;
}

function permission(value: string): void {
  if (!/^[a-z][a-z0-9.-]*(?:\.\*)?$/u.test(value) || value.length > 128) {
    throw new Error("ADMIN_PERMISSION_INVALID");
  }
}

function identifier(value: string, code: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(value)) throw new Error(code);
}

function instant(value: string, code: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error(code);
  return new Date(value).toISOString();
}

function control(value: string): boolean {
  return Array.from(value).some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point < 32 || point === 127;
  });
}
