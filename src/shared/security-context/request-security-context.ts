export type WorkloadKind = "site_product" | "admin_workload" | "platform_worker";
export type ActorKind = "anonymous" | "user" | "operator" | "workload";

export interface TrustedCallerContext {
  readonly kind: WorkloadKind;
  readonly workloadIdentityId: string;
  readonly siteId?: string;
  readonly siteReleaseRef?: string;
  readonly siteSecurityEpoch?: string;
  readonly environment: string;
  readonly region: string;
  readonly audience: string;
  readonly allowedOperations: readonly string[];
  readonly bindingEpoch: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface SecurityPrincipal {
  readonly kind: ActorKind;
  readonly subjectId: string;
  readonly subjectGeneration: string;
  readonly sessionId?: string;
  readonly assuranceLevel?: "password" | "mfa" | "phishing_resistant";
  readonly factorClasses?: readonly string[];
  readonly authenticatedAt?: string;
  readonly stepUpAt?: string | null;
  readonly managedDeviceRef?: string | null;
  readonly environment?: string;
  readonly region?: string;
  readonly sessionEpoch?: string;
  readonly restrictionEpoch?: string;
}

export interface DelegatedExecutionGrant {
  readonly grantId: string;
  readonly subjectId: string;
  readonly subjectGeneration: string;
  readonly operation: string;
  readonly audience: string;
  readonly resourceDigest: string;
  readonly expiresAt: string;
  readonly epoch: string;
}

export interface RequestSecurityContext {
  readonly requestId: string;
  readonly correlationId: string;
  readonly trustedCaller: TrustedCallerContext;
  readonly actor: SecurityPrincipal;
  readonly delegatedGrant: DelegatedExecutionGrant | null;
  readonly target: {
    readonly siteId: string | null;
    readonly workspaceId: string | null;
    readonly projectId: string | null;
    readonly purpose: string;
    readonly scopes: readonly string[];
  };
  readonly audience: string;
  readonly environment: string;
  readonly region: string;
  readonly evidence: readonly {
    readonly kind: string;
    readonly evidenceId: string;
    readonly issuer: string;
  }[];
  readonly policyEpoch: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

const verifiedContextBrand: unique symbol = Symbol("VerifiedRequestSecurityContext");
export type VerifiedRequestSecurityContext = RequestSecurityContext & {
  readonly [verifiedContextBrand]: true;
};
const verifiedContexts = new WeakSet<object>();

export interface VerifiedTrustedCallerClaims {
  readonly workloadIdentityId: string;
  readonly kind: WorkloadKind;
  readonly audience: string;
  readonly environment: string;
  readonly region: string;
  readonly allowedOperations: readonly string[];
  readonly siteId: string | null;
  readonly siteReleaseRef?: string | null;
  readonly siteSecurityEpoch?: string | null;
  readonly bindingEpoch: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly issuer: string;
  readonly keyVersion: string;
}

export interface TrustedCallerCryptographicVerifier {
  /** Verifies the canonical caller credential/signature and returns claims from trusted key material. */
  verify(context: RequestSecurityContext, operation: string): Promise<VerifiedTrustedCallerClaims>;
}

export async function verifyRequestSecurityContext(
  input: unknown,
  options: {
    readonly now: string;
    readonly operation: string;
    readonly expectedAudience: string;
    readonly expectedEnvironment: string;
    readonly expectedRegion: string;
    readonly callerVerifier: TrustedCallerCryptographicVerifier;
  },
): Promise<VerifiedRequestSecurityContext> {
  const context = parseRequestSecurityContext(input);
  const now = Date.parse(instant(options.now));
  if (now < Date.parse(context.issuedAt) || now >= Date.parse(context.expiresAt) || now < Date.parse(context.trustedCaller.issuedAt) || now >= Date.parse(context.trustedCaller.expiresAt)) throw new Error("REQUEST_SECURITY_CONTEXT_EXPIRED");
  if (context.audience !== options.expectedAudience || context.environment !== options.expectedEnvironment || context.region !== options.expectedRegion) throw new Error("REQUEST_SECURITY_CONTEXT_DEPLOYMENT_MISMATCH");
  const claims = await options.callerVerifier.verify(context, options.operation);
  const callerSiteId = context.trustedCaller.siteId ?? null;
  const callerSiteReleaseRef = context.trustedCaller.siteReleaseRef ?? null;
  const callerSiteSecurityEpoch = context.trustedCaller.siteSecurityEpoch ?? null;
  if (claims.workloadIdentityId !== context.trustedCaller.workloadIdentityId || claims.kind !== context.trustedCaller.kind || claims.audience !== context.trustedCaller.audience || claims.environment !== context.trustedCaller.environment || claims.region !== context.trustedCaller.region || claims.siteId !== callerSiteId || (claims.siteReleaseRef ?? null) !== callerSiteReleaseRef || (claims.siteSecurityEpoch ?? null) !== callerSiteSecurityEpoch || claims.bindingEpoch !== context.trustedCaller.bindingEpoch || claims.issuedAt !== context.trustedCaller.issuedAt || claims.expiresAt !== context.trustedCaller.expiresAt || !sameStrings(claims.allowedOperations, context.trustedCaller.allowedOperations) || !claims.allowedOperations.includes(options.operation) || claims.issuer.length === 0 || claims.keyVersion.length === 0 || !context.evidence.some((item) => item.issuer === claims.issuer)) throw new Error("TRUSTED_CALLER_ATTESTATION_MISMATCH");
  const verified = Object.defineProperty({ ...context }, verifiedContextBrand, { value: true }) as VerifiedRequestSecurityContext;
  deepFreeze(verified);
  verifiedContexts.add(verified);
  return verified;
}

/** @internal UoW/effect-policy runtime fence; not exported by the public barrel. */
export function assertVerifiedRequestSecurityContext(
  context: VerifiedRequestSecurityContext,
  now: string,
): void {
  if (!verifiedContexts.has(context)) throw new Error("REQUEST_SECURITY_CONTEXT_NOT_VERIFIED");
  const current = Date.parse(instant(now));
  if (current < Date.parse(context.issuedAt) || current >= Date.parse(context.expiresAt) || current < Date.parse(context.trustedCaller.issuedAt) || current >= Date.parse(context.trustedCaller.expiresAt)) throw new Error("REQUEST_SECURITY_CONTEXT_EXPIRED");
}

export function parseRequestSecurityContext(input: unknown): RequestSecurityContext {
  const context = record(input, "REQUEST_SECURITY_CONTEXT_INVALID");
  rejectUnknown(context, ["requestId", "correlationId", "trustedCaller", "actor", "delegatedGrant", "target", "audience", "environment", "region", "evidence", "policyEpoch", "issuedAt", "expiresAt"]);
  const trustedCaller = parseTrustedCaller(context.trustedCaller);
  const actor = parseActor(context.actor);
  const target = record(context.target, "SECURITY_TARGET_INVALID");
  rejectUnknown(target, ["siteId", "workspaceId", "projectId", "purpose", "scopes"]);
  const evidence = array(context.evidence, "SECURITY_EVIDENCE_INVALID").map((item) => {
    const value = record(item, "SECURITY_EVIDENCE_INVALID");
    rejectUnknown(value, ["kind", "evidenceId", "issuer"]);
    return Object.freeze({ kind: text(value.kind), evidenceId: text(value.evidenceId), issuer: text(value.issuer) });
  });
  const result: RequestSecurityContext = {
    requestId: text(context.requestId), correlationId: text(context.correlationId), trustedCaller, actor,
    delegatedGrant: context.delegatedGrant === null ? null : parseGrant(context.delegatedGrant),
    target: Object.freeze({ siteId: nullableText(target.siteId), workspaceId: nullableText(target.workspaceId), projectId: nullableText(target.projectId), purpose: text(target.purpose), scopes: strings(target.scopes) }),
    audience: text(context.audience), environment: text(context.environment), region: text(context.region),
    evidence: Object.freeze(evidence), policyEpoch: epoch(context.policyEpoch),
    issuedAt: instant(context.issuedAt), expiresAt: instant(context.expiresAt),
  };
  if (result.audience !== trustedCaller.audience || result.environment !== trustedCaller.environment || result.region !== trustedCaller.region) throw new Error("SECURITY_CALLER_AXIS_MISMATCH");
  if (Date.parse(result.expiresAt) <= Date.parse(result.issuedAt)) throw new Error("SECURITY_CONTEXT_EXPIRY_INVALID");
  if (Date.parse(result.issuedAt) < Date.parse(trustedCaller.issuedAt) || Date.parse(result.expiresAt) > Date.parse(trustedCaller.expiresAt)) throw new Error("SECURITY_CONTEXT_OUTLIVES_CALLER");
  if (trustedCaller.kind === "site_product" && trustedCaller.siteId !== result.target.siteId) throw new Error("SECURITY_TARGET_SITE_MISMATCH");
  if (actor.environment !== undefined && actor.environment !== result.environment) throw new Error("SECURITY_ACTOR_ENVIRONMENT_MISMATCH");
  if (actor.region !== undefined && actor.region !== result.region) throw new Error("SECURITY_ACTOR_REGION_MISMATCH");
  return deepFreeze(result);
}

function parseTrustedCaller(input: unknown): TrustedCallerContext {
  const value = record(input, "TRUSTED_CALLER_INVALID");
  rejectUnknown(value, ["kind", "workloadIdentityId", "siteId", "siteReleaseRef", "siteSecurityEpoch", "environment", "region", "audience", "allowedOperations", "bindingEpoch", "issuedAt", "expiresAt"]);
  const kind = text(value.kind);
  if (!["site_product", "admin_workload", "platform_worker"].includes(kind)) throw new Error("TRUSTED_CALLER_KIND_INVALID");
  const caller: TrustedCallerContext = { kind: kind as WorkloadKind, workloadIdentityId: text(value.workloadIdentityId), environment: text(value.environment), region: text(value.region), audience: text(value.audience), allowedOperations: strings(value.allowedOperations), bindingEpoch: epoch(value.bindingEpoch), issuedAt: instant(value.issuedAt), expiresAt: instant(value.expiresAt), ...(value.siteId === undefined ? {} : { siteId: text(value.siteId) }), ...(value.siteReleaseRef === undefined ? {} : { siteReleaseRef: text(value.siteReleaseRef) }), ...(value.siteSecurityEpoch === undefined ? {} : { siteSecurityEpoch: epoch(value.siteSecurityEpoch) }) };
  if (caller.kind === "site_product" && (!caller.siteId || caller.siteReleaseRef === undefined || caller.siteSecurityEpoch === undefined)) throw new Error("TRUSTED_SITE_REQUIRED");
  if (caller.kind !== "site_product" && (caller.siteReleaseRef !== undefined || caller.siteSecurityEpoch !== undefined)) throw new Error("TRUSTED_SITE_SECURITY_EPOCH_INVALID");
  return deepFreeze(caller);
}

function parseActor(input: unknown): SecurityPrincipal {
  const value = record(input, "SECURITY_ACTOR_INVALID");
  rejectUnknown(value, ["kind", "subjectId", "subjectGeneration", "sessionId", "assuranceLevel", "factorClasses", "authenticatedAt", "stepUpAt", "managedDeviceRef", "environment", "region", "sessionEpoch", "restrictionEpoch"]);
  const kind = text(value.kind);
  if (!["anonymous", "user", "operator", "workload"].includes(kind)) throw new Error("SECURITY_ACTOR_KIND_INVALID");
  return deepFreeze({ kind: kind as ActorKind, subjectId: text(value.subjectId), subjectGeneration: epoch(value.subjectGeneration), ...optionalTextFields(value, ["sessionId", "assuranceLevel", "authenticatedAt", "environment", "region", "sessionEpoch", "restrictionEpoch"]), ...(value.factorClasses === undefined ? {} : { factorClasses: strings(value.factorClasses) }), ...(value.stepUpAt === undefined ? {} : { stepUpAt: nullableInstant(value.stepUpAt) }), ...(value.managedDeviceRef === undefined ? {} : { managedDeviceRef: nullableText(value.managedDeviceRef) }) } as SecurityPrincipal);
}

function parseGrant(input: unknown): DelegatedExecutionGrant {
  const value = record(input, "DELEGATED_GRANT_INVALID");
  rejectUnknown(value, ["grantId", "subjectId", "subjectGeneration", "operation", "audience", "resourceDigest", "expiresAt", "epoch"]);
  return deepFreeze({ grantId: text(value.grantId), subjectId: text(value.subjectId), subjectGeneration: epoch(value.subjectGeneration), operation: text(value.operation), audience: text(value.audience), resourceDigest: digest(value.resourceDigest), expiresAt: instant(value.expiresAt), epoch: epoch(value.epoch) });
}

function record(value: unknown, code: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code); return value as Record<string, unknown>; }
function array(value: unknown, code: string): readonly unknown[] { if (!Array.isArray(value)) throw new Error(code); return value; }
function text(value: unknown): string { if (typeof value !== "string" || value.length === 0) throw new Error("NON_EMPTY_STRING_REQUIRED"); return value; }
function nullableText(value: unknown): string | null { return value === null ? null : text(value); }
function strings(value: unknown): readonly string[] { const values = array(value, "STRING_ARRAY_REQUIRED").map(text); if (new Set(values).size !== values.length) throw new Error("DUPLICATE_SECURITY_VALUE"); return Object.freeze(values); }
function epoch(value: unknown): string { const parsed = text(value); if (!/^(?:0|[1-9][0-9]*)$/u.test(parsed)) throw new Error("SECURITY_EPOCH_INVALID"); return parsed; }
function digest(value: unknown): string { const parsed = text(value); if (!/^[a-f0-9]{64}$/u.test(parsed)) throw new Error("SHA256_DIGEST_REQUIRED"); return parsed; }
function instant(value: unknown): string { const parsed = text(value); if (!Number.isFinite(Date.parse(parsed))) throw new Error("INSTANT_INVALID"); return parsed; }
function nullableInstant(value: unknown): string | null { return value === null ? null : instant(value); }
function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[]): void { const unknown = Object.keys(value).filter((key) => !allowed.includes(key)); if (unknown.length > 0) throw new Error(`UNKNOWN_SECURITY_FIELD:${unknown.sort().join(",")}`); }
function optionalTextFields(value: Record<string, unknown>, names: readonly string[]): Record<string, string> { return Object.fromEntries(names.filter((name) => value[name] !== undefined).map((name) => [name, name.endsWith("Epoch") ? epoch(value[name]) : text(value[name])])); }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object") { for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); Object.freeze(value); } return value; }
function sameStrings(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]); }
