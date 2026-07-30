import type {
  AdminOidcProviderClaims,
  AdminWorkloadAxes,
} from "../../application/services/admin-oidc-service.js";
import type { AdminIdentityTransactionHost } from "./admin-oidc-store.js";
import { resolvePlatformTransaction } from
  "../../../../shared/unit-of-work/platform-transaction.js";

interface OperatorRow extends Record<string, unknown> {
  operatorRef: unknown;
  operatorGeneration: unknown;
  operatorSecurityEpoch: unknown;
  restrictionEpoch: unknown;
  policyEpoch: unknown;
  permissions: unknown;
  expiresAt: unknown;
}

interface SiteScopeRow extends Record<string, unknown> {
  siteRef: unknown; environment: unknown; region: unknown; scopeEpoch: unknown; expiresAt: unknown;
}
interface GlobalScopeRow extends Record<string, unknown> {
  grantRef: unknown; environment: unknown; region: unknown; scopeEpoch: unknown; expiresAt: unknown;
}
interface BreakGlassScopeRow extends GlobalScopeRow {
  incidentRef: unknown; authorizedOperation: unknown; resourceRefs: unknown; fieldAllowlist: unknown;
}

export class PostgresAdminOperatorResolver {
  constructor(private readonly host: AdminIdentityTransactionHost) {}

  resolve(claims: AdminOidcProviderClaims, axes: AdminWorkloadAxes) {
    return this.host.adminIdentityTransaction(
      { operation: "admin.identity.exchange", ...axes },
      async (ownerTransaction) => {
        const sql = resolvePlatformTransaction(ownerTransaction);
        const rows = await sql.query<OperatorRow>(
          `SELECT authority.operator_ref AS "operatorRef",
                  authority.operator_generation AS "operatorGeneration",
                  authority.operator_security_epoch AS "operatorSecurityEpoch",
                  authority.authorization_epoch AS "restrictionEpoch",
                  authority.authorization_epoch AS "policyEpoch",
                  authority.permissions,authority.expires_at AS "expiresAt"
           FROM platform.admin_operator_identity identity_row
           JOIN platform.admin_operator_authority authority
             ON authority.operator_ref=identity_row.operator_ref
            AND authority.operator_generation=identity_row.operator_generation
           WHERE identity_row.issuer=$1 AND identity_row.subject=$2
             AND identity_row.state='active' AND authority.state='active'
             AND authority.expires_at>now() LIMIT 1`,
          [claims.issuer, claims.subject],
        );
        const row = rows[0];
        if (row === undefined) return null;
        const operatorRef = text(row.operatorRef);
        const operatorGeneration = positive(row.operatorGeneration);
        const now = new Date().toISOString();
        const [siteScopes, globalScopes, breakGlassScopes] = await Promise.all([
          sql.query<SiteScopeRow>(
            `SELECT site_ref AS "siteRef",environment,region,scope_epoch AS "scopeEpoch",
                    expires_at AS "expiresAt"
             FROM platform.admin_operator_site_scope
             WHERE operator_ref=$1 AND operator_generation=$2 AND state='active'
               AND expires_at>$3::timestamptz ORDER BY site_ref`,
            [operatorRef, operatorGeneration, now],
          ),
          sql.query<GlobalScopeRow>(
            `SELECT grant_ref::text AS "grantRef",environment,region,scope_epoch AS "scopeEpoch",
                    expires_at AS "expiresAt"
             FROM platform.admin_operator_global_scope_grant
             WHERE operator_ref=$1 AND operator_generation=$2 AND state='active'
               AND expires_at>$3::timestamptz ORDER BY grant_ref`,
            [operatorRef, operatorGeneration, now],
          ),
          sql.query<BreakGlassScopeRow>(
            `SELECT grant_ref::text AS "grantRef",incident_ref AS "incidentRef",environment,region,
                    authorized_operation AS "authorizedOperation",resource_refs AS "resourceRefs",
                    field_allowlist AS "fieldAllowlist",scope_epoch AS "scopeEpoch",
                    expires_at AS "expiresAt"
             FROM platform.admin_breakglass_grant
             WHERE operator_ref=$1 AND operator_generation=$2 AND state='active'
               AND expires_at>$3::timestamptz ORDER BY grant_ref`,
            [operatorRef, operatorGeneration, now],
          ),
        ]);
        return Object.freeze({
          operatorRef,
          operatorGeneration,
          operatorSecurityEpoch: positive(row.operatorSecurityEpoch),
          restrictionEpoch: positive(row.restrictionEpoch),
          policyEpoch: positive(row.policyEpoch),
          permissions: strings(row.permissions),
          expiresAt: instant(row.expiresAt),
          siteScopes: Object.freeze(siteScopes.map((scope) => Object.freeze({
            siteRef: text(scope.siteRef), environment: text(scope.environment),
            region: text(scope.region), scopeEpoch: positive(scope.scopeEpoch),
            expiresAt: instant(scope.expiresAt),
          }))),
          globalScopes: Object.freeze(globalScopes.map((scope) => Object.freeze({
            grantRef: text(scope.grantRef), environment: text(scope.environment),
            region: text(scope.region), scopeEpoch: positive(scope.scopeEpoch),
            expiresAt: instant(scope.expiresAt),
          }))),
          breakGlassScopes: Object.freeze(breakGlassScopes.map((scope) => Object.freeze({
            grantRef: text(scope.grantRef), incidentRef: text(scope.incidentRef),
            environment: text(scope.environment), region: text(scope.region),
            authorizedOperation: text(scope.authorizedOperation),
            resourceRefs: strings(scope.resourceRefs), fieldAllowlist: strings(scope.fieldAllowlist),
            scopeEpoch: positive(scope.scopeEpoch), expiresAt: instant(scope.expiresAt),
          }))),
        });
      },
    );
  }
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.length < 1) throw new Error("ADMIN_OPERATOR_ROW_CORRUPT");
  return value;
}

function positive(value: unknown): bigint {
  const result = typeof value === "bigint" ? value : typeof value === "string" ? BigInt(value) : 0n;
  if (result < 1n) throw new Error("ADMIN_OPERATOR_ROW_CORRUPT");
  return result;
}

function strings(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length < 1)) {
    throw new Error("ADMIN_OPERATOR_ROW_CORRUPT");
  }
  const result = value as string[];
  if (new Set(result).size !== result.length) throw new Error("ADMIN_OPERATOR_ROW_CORRUPT");
  return Object.freeze([...result]);
}

function instant(value: unknown): string {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (date === null || !Number.isFinite(date.getTime())) throw new Error("ADMIN_OPERATOR_ROW_CORRUPT");
  return date.toISOString();
}
