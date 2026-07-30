export type AdminAssuranceLevel = "password" | "mfa" | "phishing_resistant";

export interface AuthenticatedAdminSession {
  readonly operatorRef: string;
  readonly operatorGeneration: bigint;
  readonly operatorSecurityEpoch: bigint;
  readonly sessionRef: string;
  readonly sessionEpoch: bigint;
  readonly restrictionEpoch: bigint;
  readonly policyEpoch: bigint;
  readonly workloadIdentityRef: string;
  readonly audience: string;
  readonly environment: string;
  readonly region: string;
  readonly managedDeviceRef: string;
  readonly assuranceLevel: AdminAssuranceLevel;
  readonly factorClasses: readonly string[];
  readonly authenticatedAt: string;
  readonly stepUpAt: string | null;
  readonly expiresAt: string;
}

export interface AdminSiteScopeGrant {
  readonly siteRef: string;
  readonly environment: string;
  readonly region: string;
  readonly scopeEpoch: bigint;
  readonly expiresAt: string;
}

export interface AdminGlobalScopeGrant {
  readonly grantRef: string;
  readonly environment: string;
  readonly region: string;
  readonly scopeEpoch: bigint;
  readonly expiresAt: string;
}

export interface AdminBreakGlassScopeGrant extends AdminGlobalScopeGrant {
  readonly incidentRef: string;
  readonly authorizedOperation: string;
  readonly resourceRefs: readonly string[];
  readonly fieldAllowlist: readonly string[];
}

export interface AdminOperatorAuthority {
  readonly operatorRef: string;
  readonly operatorGeneration: bigint;
  readonly operatorSecurityEpoch: bigint;
  readonly authorizationEpoch: bigint;
  readonly state: "active" | "suspended" | "revoked";
  readonly permissions: readonly string[];
  readonly expiresAt: string;
  readonly siteScopes: readonly AdminSiteScopeGrant[];
  readonly globalScopes: readonly AdminGlobalScopeGrant[];
  readonly breakGlassScopes: readonly AdminBreakGlassScopeGrant[];
}

export type RequestedAdminScope =
  | Readonly<{
      kind: "site";
      siteRefs: readonly string[];
      environment: string;
      region: string;
    }>
  | Readonly<{
      kind: "global";
      grantRef: string;
      environment: string;
      region: string;
    }>
  | Readonly<{
      kind: "breakglass";
      grantRef: string;
      incidentRef: string;
      environment: string;
      region: string;
      authorizedOperation: string;
      resourceRefs: readonly string[];
      fieldAllowlist: readonly string[];
      expiresAt: string;
    }>;

export type AuthorizedAdminScope =
  | Readonly<{ kind: "site"; siteRef: string; scopeEpoch: bigint }>
  | Readonly<{ kind: "global"; grantRef: string; scopeEpoch: bigint }>
  | Readonly<{
      kind: "breakglass";
      grantRef: string;
      incidentRef: string;
      scopeEpoch: bigint;
      resourceRefs: readonly string[];
      fieldAllowlist: readonly string[];
    }>;

export function authorizeAdminOperation(input: Readonly<{
  session: AuthenticatedAdminSession;
  authority: AdminOperatorAuthority;
  operation: string;
  requiredPermission: string;
  scope: RequestedAdminScope;
  target: Readonly<{
    siteRef: string | null;
    resourceRefs: readonly string[];
    fieldRefs: readonly string[];
  }>;
  now: Date;
  mutation: boolean;
  authorityTargetOperatorRef?: string;
}>): AuthorizedAdminScope {
  const now = input.now.getTime();
  if (!Number.isFinite(now)) throw new Error("ADMIN_AUTHORIZATION_TIME_INVALID");
  verifySession(input.session, now);
  verifyAuthority(input.authority, now);
  if (
    input.session.operatorRef !== input.authority.operatorRef ||
    input.session.operatorGeneration !== input.authority.operatorGeneration
  ) throw new Error("ADMIN_SESSION_AUTHORITY_MISMATCH");
  if (input.session.operatorSecurityEpoch !== input.authority.operatorSecurityEpoch) {
    throw new Error("ADMIN_SESSION_SECURITY_EPOCH_STALE");
  }
  if (!permits(input.authority.permissions, input.requiredPermission)) {
    throw new Error("ADMIN_PERMISSION_DENIED");
  }
  if (
    input.session.environment !== input.scope.environment ||
    input.session.region !== input.scope.region
  ) throw new Error("ADMIN_SCOPE_DEPLOYMENT_MISMATCH");
  if (input.mutation) {
    const stepUpAt = input.session.stepUpAt === null ? Number.NaN : Date.parse(input.session.stepUpAt);
    if (
      input.session.assuranceLevel !== "phishing_resistant" ||
      input.session.stepUpAt === null ||
      !Number.isFinite(stepUpAt) ||
      now - stepUpAt > 5 * 60_000 ||
      stepUpAt > now
    ) throw new Error("ADMIN_STEP_UP_REQUIRED");
    if (
      input.authorityTargetOperatorRef !== undefined &&
      input.authorityTargetOperatorRef === input.session.operatorRef
    ) throw new Error("ADMIN_SELF_ESCALATION_DENIED");
  }

  if (input.scope.kind === "site") {
    if (
      input.scope.siteRefs.length < 1 || input.scope.siteRefs.length > 100 ||
      input.scope.siteRefs.some((siteRef) => siteRef === "*" || !identifier(siteRef)) ||
      new Set(input.scope.siteRefs).size !== input.scope.siteRefs.length ||
      input.target.siteRef === null || !input.scope.siteRefs.includes(input.target.siteRef)
    ) throw new Error("ADMIN_SITE_SCOPE_INVALID");
    const grant = input.authority.siteScopes.find((candidate) =>
      candidate.siteRef === input.target.siteRef &&
      candidate.environment === input.scope.environment &&
      candidate.region === input.scope.region &&
      Date.parse(candidate.expiresAt) > now,
    );
    if (grant === undefined) throw new Error("ADMIN_SITE_SCOPE_DENIED");
    return Object.freeze({ kind: "site", siteRef: grant.siteRef, scopeEpoch: grant.scopeEpoch });
  }

  if (input.scope.kind === "global") {
    const globalScope = input.scope;
    if (input.target.siteRef !== null || !identifier(globalScope.grantRef)) {
      throw new Error("ADMIN_GLOBAL_SCOPE_INVALID");
    }
    const grant = input.authority.globalScopes.find((candidate) =>
      candidate.grantRef === globalScope.grantRef &&
      candidate.environment === globalScope.environment &&
      candidate.region === globalScope.region &&
      Date.parse(candidate.expiresAt) > now,
    );
    if (grant === undefined) throw new Error("ADMIN_GLOBAL_SCOPE_DENIED");
    return Object.freeze({ kind: "global", grantRef: grant.grantRef, scopeEpoch: grant.scopeEpoch });
  }

  const breakGlassScope = input.scope;
  const requestedBreakGlassExpiry = Date.parse(breakGlassScope.expiresAt);
  if (
    input.target.siteRef !== null ||
    breakGlassScope.authorizedOperation !== input.operation ||
    !Number.isFinite(requestedBreakGlassExpiry) ||
    requestedBreakGlassExpiry <= now ||
    requestedBreakGlassExpiry - now > 30 * 60_000
  ) throw new Error("ADMIN_BREAKGLASS_SCOPE_INVALID");
  const grant = input.authority.breakGlassScopes.find((candidate) =>
    candidate.grantRef === breakGlassScope.grantRef &&
    candidate.incidentRef === breakGlassScope.incidentRef &&
    candidate.environment === breakGlassScope.environment &&
    candidate.region === breakGlassScope.region &&
    candidate.authorizedOperation === input.operation &&
    candidate.expiresAt === breakGlassScope.expiresAt &&
    sameSet(candidate.resourceRefs, breakGlassScope.resourceRefs) &&
    sameSet(candidate.fieldAllowlist, breakGlassScope.fieldAllowlist) &&
    Date.parse(candidate.expiresAt) > now && Date.parse(candidate.expiresAt) - now <= 30 * 60_000,
  );
  if (grant === undefined) throw new Error("ADMIN_BREAKGLASS_SCOPE_DENIED");
  if (
    !input.target.resourceRefs.every((resource) => grant.resourceRefs.includes(resource)) ||
    !input.target.fieldRefs.every((field) => grant.fieldAllowlist.includes(field))
  ) throw new Error("ADMIN_BREAKGLASS_TARGET_DENIED");
  return Object.freeze({
    kind: "breakglass",
    grantRef: grant.grantRef,
    incidentRef: grant.incidentRef,
    scopeEpoch: grant.scopeEpoch,
    resourceRefs: Object.freeze([...grant.resourceRefs]),
    fieldAllowlist: Object.freeze([...grant.fieldAllowlist]),
  });
}

function verifySession(session: AuthenticatedAdminSession, now: number): void {
  const expiresAt = Date.parse(session.expiresAt);
  const authenticatedAt = Date.parse(session.authenticatedAt);
  if (
    !identifier(session.operatorRef) || !identifier(session.sessionRef) ||
    !identifier(session.workloadIdentityRef) || !identifier(session.managedDeviceRef) ||
    session.operatorGeneration < 1n || session.operatorSecurityEpoch < 1n ||
    session.sessionEpoch < 1n || session.restrictionEpoch < 1n || session.policyEpoch < 1n ||
    !Number.isFinite(expiresAt) || !Number.isFinite(authenticatedAt) ||
    expiresAt <= now || authenticatedAt > now || session.factorClasses.length < 1 ||
    new Set(session.factorClasses).size !== session.factorClasses.length
  ) throw new Error("ADMIN_SESSION_INVALID");
}

function verifyAuthority(authority: AdminOperatorAuthority, now: number): void {
  const expiresAt = Date.parse(authority.expiresAt);
  if (
    authority.state !== "active" || authority.authorizationEpoch < 1n ||
    !Number.isFinite(expiresAt) || expiresAt <= now ||
    authority.permissions.length < 1 || new Set(authority.permissions).size !== authority.permissions.length
  ) throw new Error("ADMIN_OPERATOR_AUTHORITY_INVALID");
}

function permits(grants: readonly string[], required: string): boolean {
  return grants.includes(required) || grants.some((grant) =>
    grant.endsWith(".*") && required.startsWith(grant.slice(0, -1)));
}

function identifier(value: string): boolean {
  return value.length >= 3 && value.length <= 256 &&
    !Array.from(value).some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point < 32 || point === 127;
    });
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index]);
}
