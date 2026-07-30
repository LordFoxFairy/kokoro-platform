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
}

export class PostgresAdminOperatorResolver {
  constructor(private readonly host: AdminIdentityTransactionHost) {}

  resolve(claims: AdminOidcProviderClaims, axes: AdminWorkloadAxes) {
    return this.host.adminIdentityTransaction(
      { operation: "admin.identity.exchange", ...axes },
      async (ownerTransaction) => {
        const rows = await resolvePlatformTransaction(ownerTransaction).query<OperatorRow>(
          `SELECT authority.operator_ref AS "operatorRef",
                  authority.operator_generation AS "operatorGeneration",
                  authority.operator_security_epoch AS "operatorSecurityEpoch",
                  authority.authorization_epoch AS "restrictionEpoch",
                  authority.authorization_epoch AS "policyEpoch"
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
        return Object.freeze({
          operatorRef: text(row.operatorRef),
          operatorGeneration: positive(row.operatorGeneration),
          operatorSecurityEpoch: positive(row.operatorSecurityEpoch),
          restrictionEpoch: positive(row.restrictionEpoch),
          policyEpoch: positive(row.policyEpoch),
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
