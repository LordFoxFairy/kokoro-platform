import type {
  AdminOperatorAuthority,
  AuthenticatedAdminSession,
} from "../../domain/admin-authorization.js";
import type { AdminWorkloadAxes } from
  "../../application/services/admin-oidc-service.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import { resolvePlatformTransaction } from
  "../../../../shared/unit-of-work/platform-transaction.js";

export interface AdminAuthenticationTransactionHost {
  adminAuthenticationTransaction<Result>(
    fence: Readonly<AdminWorkloadAxes & { credentialDigest: string }>,
    work: (transaction: PlatformTransaction) => Promise<Result>,
  ): Promise<Result>;
}

export interface AuthenticatedAdminFacts {
  readonly session: AuthenticatedAdminSession;
  readonly authority: AdminOperatorAuthority;
}

interface SessionRow extends Record<string, unknown> {
  sessionRef: unknown;
  operatorRef: unknown;
  operatorGeneration: unknown;
  workloadIdentityRef: unknown;
  audience: unknown;
  environment: unknown;
  region: unknown;
  managedDeviceRef: unknown;
  operatorSecurityEpoch: unknown;
  sessionEpoch: unknown;
  restrictionEpoch: unknown;
  policyEpoch: unknown;
  assuranceLevel: unknown;
  factorClasses: unknown;
  authenticatedAt: unknown;
  stepUpAt: unknown;
  expiresAt: unknown;
}

interface AuthorityRow extends Record<string, unknown> {
  operatorRef: unknown;
  operatorGeneration: unknown;
  operatorSecurityEpoch: unknown;
  state: unknown;
  permissions: unknown;
  expiresAt: unknown;
}

interface SiteGrantRow extends Record<string, unknown> {
  siteRef: unknown;
  environment: unknown;
  region: unknown;
  scopeEpoch: unknown;
  expiresAt: unknown;
}

interface GlobalGrantRow extends Record<string, unknown> {
  grantRef: unknown;
  environment: unknown;
  region: unknown;
  scopeEpoch: unknown;
  expiresAt: unknown;
}

interface BreakGlassGrantRow extends GlobalGrantRow {
  incidentRef: unknown;
  authorizedOperation: unknown;
  resourceRefs: unknown;
  fieldAllowlist: unknown;
}

export class PostgresAdminSessionAuthenticator {
  constructor(private readonly host: AdminAuthenticationTransactionHost) {}

  authenticate(input: Readonly<AdminWorkloadAxes & { credentialDigest: string; now: string }>) {
    digest(input.credentialDigest);
    return this.host.adminAuthenticationTransaction(input, async (ownerTransaction) => {
      const sql = resolvePlatformTransaction(ownerTransaction);
      const sessions = await sql.query<SessionRow>(
        `SELECT operator_session_ref AS "sessionRef",operator_ref AS "operatorRef",
                operator_generation AS "operatorGeneration",
                workload_identity_ref AS "workloadIdentityRef",audience,environment,region,
                managed_device_ref AS "managedDeviceRef",
                operator_security_epoch AS "operatorSecurityEpoch",session_epoch AS "sessionEpoch",
                restriction_epoch AS "restrictionEpoch",policy_epoch AS "policyEpoch",
                assurance_level AS "assuranceLevel",factor_classes AS "factorClasses",
                authenticated_at AS "authenticatedAt",step_up_at AS "stepUpAt",
                expires_at AS "expiresAt"
         FROM platform.admin_operator_session
         WHERE credential_digest=$1 AND workload_identity_ref=$2 AND environment=$3 AND region=$4
           AND managed_device_ref=$5 AND audience=$6 AND state='active'
           AND expires_at>$7::timestamptz LIMIT 1`,
        [input.credentialDigest, input.workloadIdentityRef, input.environment, input.region,
          input.managedDeviceRef, input.audience, input.now],
      );
      const row = sessions[0];
      if (row === undefined) return null;
      const session = mapSession(row);
      await sql.query(
        `SELECT set_config('app.subject_id',$1,true),
                set_config('app.subject_generation',$2,true)`,
        [session.operatorRef, session.operatorGeneration.toString()],
      );
      const [authorities, siteScopes, globalScopes, breakGlassScopes] = await Promise.all([
        sql.query<AuthorityRow>(
          `SELECT operator_ref AS "operatorRef",operator_generation AS "operatorGeneration",
                  operator_security_epoch AS "operatorSecurityEpoch",state,permissions,
                  expires_at AS "expiresAt"
           FROM platform.admin_operator_authority
           WHERE operator_ref=$1 AND operator_generation=$2 LIMIT 1`,
          [session.operatorRef, session.operatorGeneration],
        ),
        sql.query<SiteGrantRow>(
          `SELECT site_ref AS "siteRef",environment,region,scope_epoch AS "scopeEpoch",
                  expires_at AS "expiresAt"
           FROM platform.admin_operator_site_scope
           WHERE operator_ref=$1 AND operator_generation=$2 AND state='active'
             AND expires_at>$3::timestamptz`,
          [session.operatorRef, session.operatorGeneration, input.now],
        ),
        sql.query<GlobalGrantRow>(
          `SELECT grant_ref::text AS "grantRef",environment,region,scope_epoch AS "scopeEpoch",
                  expires_at AS "expiresAt"
           FROM platform.admin_operator_global_scope_grant
           WHERE operator_ref=$1 AND operator_generation=$2 AND state='active'
             AND expires_at>$3::timestamptz`,
          [session.operatorRef, session.operatorGeneration, input.now],
        ),
        sql.query<BreakGlassGrantRow>(
          `SELECT grant_ref::text AS "grantRef",incident_ref AS "incidentRef",environment,region,
                  authorized_operation AS "authorizedOperation",resource_refs AS "resourceRefs",
                  field_allowlist AS "fieldAllowlist",scope_epoch AS "scopeEpoch",
                  expires_at AS "expiresAt"
           FROM platform.admin_breakglass_grant
           WHERE operator_ref=$1 AND operator_generation=$2 AND state='active'
             AND expires_at>$3::timestamptz`,
          [session.operatorRef, session.operatorGeneration, input.now],
        ),
      ]);
      const authority = authorities[0];
      if (authority === undefined) return null;
      return Object.freeze({
        session,
        authority: Object.freeze({
          operatorRef: text(authority.operatorRef),
          operatorGeneration: positive(authority.operatorGeneration),
          operatorSecurityEpoch: positive(authority.operatorSecurityEpoch),
          state: authorityState(authority.state),
          permissions: strings(authority.permissions),
          expiresAt: instant(authority.expiresAt),
          siteScopes: Object.freeze(siteScopes.map((grant) => Object.freeze({
            siteRef: text(grant.siteRef), environment: text(grant.environment),
            region: text(grant.region), scopeEpoch: positive(grant.scopeEpoch),
            expiresAt: instant(grant.expiresAt),
          }))),
          globalScopes: Object.freeze(globalScopes.map((grant) => Object.freeze({
            grantRef: text(grant.grantRef), environment: text(grant.environment),
            region: text(grant.region), scopeEpoch: positive(grant.scopeEpoch),
            expiresAt: instant(grant.expiresAt),
          }))),
          breakGlassScopes: Object.freeze(breakGlassScopes.map((grant) => Object.freeze({
            grantRef: text(grant.grantRef), incidentRef: text(grant.incidentRef),
            environment: text(grant.environment), region: text(grant.region),
            authorizedOperation: text(grant.authorizedOperation),
            resourceRefs: strings(grant.resourceRefs), fieldAllowlist: strings(grant.fieldAllowlist),
            scopeEpoch: positive(grant.scopeEpoch), expiresAt: instant(grant.expiresAt),
          }))),
        }),
      });
    });
  }
}

function mapSession(row: SessionRow): AuthenticatedAdminSession {
  const assurance = row.assuranceLevel;
  if (assurance !== "password" && assurance !== "mfa" && assurance !== "phishing_resistant") {
    throw new Error("ADMIN_SESSION_ROW_CORRUPT");
  }
  return Object.freeze({
    sessionRef: text(row.sessionRef), operatorRef: text(row.operatorRef),
    operatorGeneration: positive(row.operatorGeneration),
    workloadIdentityRef: text(row.workloadIdentityRef), audience: text(row.audience),
    environment: text(row.environment), region: text(row.region),
    managedDeviceRef: text(row.managedDeviceRef),
    operatorSecurityEpoch: positive(row.operatorSecurityEpoch),
    sessionEpoch: positive(row.sessionEpoch), restrictionEpoch: positive(row.restrictionEpoch),
    policyEpoch: positive(row.policyEpoch), assuranceLevel: assurance,
    factorClasses: strings(row.factorClasses), authenticatedAt: instant(row.authenticatedAt),
    stepUpAt: row.stepUpAt === null ? null : instant(row.stepUpAt), expiresAt: instant(row.expiresAt),
  });
}

function authorityState(value: unknown): "active" | "suspended" | "revoked" {
  if (value !== "active" && value !== "suspended" && value !== "revoked") {
    throw new Error("ADMIN_AUTHORITY_ROW_CORRUPT");
  }
  return value;
}

function digest(value: unknown): string {
  const result = text(value);
  if (!/^[a-f0-9]{64}$/u.test(result)) throw new Error("ADMIN_CREDENTIAL_DIGEST_INVALID");
  return result;
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.length < 1) throw new Error("ADMIN_AUTHORITY_ROW_CORRUPT");
  return value;
}

function positive(value: unknown): bigint {
  const result = typeof value === "bigint" ? value : typeof value === "string" ? BigInt(value) : 0n;
  if (result < 1n) throw new Error("ADMIN_AUTHORITY_ROW_CORRUPT");
  return result;
}

function strings(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.some((item) => typeof item !== "string" || item.length < 1)) {
    throw new Error("ADMIN_AUTHORITY_ROW_CORRUPT");
  }
  const result = value as string[];
  if (new Set(result).size !== result.length) throw new Error("ADMIN_AUTHORITY_ROW_CORRUPT");
  return Object.freeze([...result]);
}

function instant(value: unknown): string {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (date === null || !Number.isFinite(date.getTime())) throw new Error("ADMIN_AUTHORITY_ROW_CORRUPT");
  return date.toISOString();
}
