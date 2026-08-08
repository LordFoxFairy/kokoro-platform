import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import { resolvePlatformTransaction } from
  "../../../../shared/unit-of-work/platform-transaction.js";
import type {
  AdminPendingApprovalCursor,
  AdminPendingApprovalOwner,
  AdminQueryPermit,
  AdminQueryReader,
} from "../../interfaces/connect/admin-query-service.js";

export interface AdminQueryTransactionHost {
  adminQueryTransaction<Result>(
    permit: AdminQueryPermit,
    work: (transaction: PlatformTransaction) => Promise<Result>,
  ): Promise<Result>;
}

interface SiteRow extends Record<string, unknown> {
  siteRef: string;
  status: string;
  securityEpoch: bigint | string;
}

interface UserRow extends Record<string, unknown> {
  userRef: string;
  status: string;
  securityEpoch: bigint | string;
}

interface AuditRow extends Record<string, unknown> {
  auditRef: string;
  actionCode: string;
  occurredAt: Date | string;
}

interface OperatorRow extends Record<string, unknown> {
  operatorRef: string; operatorGeneration: bigint | string; state: string;
  effectivePermissions: unknown; effectiveSiteScopes: unknown;
  operatorSecurityEpoch: bigint | string; authorizationEpoch: bigint | string;
  expiresAt: Date | string;
}

interface ApprovalRow extends Record<string, unknown> {
  owner: string;
  approvalRef: string; operation: string; makerRef: string; targetSiteRef: string | null;
  environment: string; region: string; operatorReason: string;
  admittedAt: string; expiresAt: string;
}

export class PostgresAdminQueryReader implements AdminQueryReader {
  constructor(private readonly host: AdminQueryTransactionHost) {}

  getSite(permit: AdminQueryPermit, siteRef: string) {
    requireSiteAccess(permit, siteRef);
    return this.host.adminQueryTransaction(permit, async (ownerTransaction) => {
      const rows = await resolvePlatformTransaction(ownerTransaction).query<SiteRow>(
        `SELECT site.site_ref AS "siteRef",site.state AS status,
                site.security_epoch AS "securityEpoch"
         FROM platform.site site
         WHERE site.site_ref=$1 AND ${deploymentFence()}
         LIMIT 1`,
        [siteRef, permit.environment, permit.region],
      );
      return rows[0] === undefined ? null : site(rows[0]);
    });
  }

  listSites(
    permit: AdminQueryPermit,
    page: Readonly<{ afterSiteRef: string | null; limit: number }>,
  ) {
    const allowed = allowedSiteRefs(permit);
    return this.host.adminQueryTransaction(permit, async (ownerTransaction) => {
      const values: unknown[] = [permit.environment, permit.region, page.afterSiteRef ?? "", page.limit];
      const scope = allowed === null ? "TRUE" : "site.site_ref=ANY($5::text[])";
      if (allowed !== null) values.push(allowed);
      const rows = await resolvePlatformTransaction(ownerTransaction).query<SiteRow>(
        `SELECT site.site_ref AS "siteRef",site.state AS status,
                site.security_epoch AS "securityEpoch"
         FROM platform.site site
         WHERE site.site_ref>$3 AND ${scope}
           AND EXISTS (
             SELECT 1 FROM platform.site_deployment_binding deployment
             WHERE deployment.site_ref=site.site_ref AND deployment.environment=$1
               AND deployment.region=$2 AND deployment.state='active'
           )
         ORDER BY site.site_ref ASC LIMIT $4`,
        values,
      );
      return Object.freeze(rows.map(site));
    });
  }

  getUser(permit: AdminQueryPermit, siteRef: string, userRef: string) {
    requireSiteAccess(permit, siteRef);
    return this.host.adminQueryTransaction(permit, async (ownerTransaction) => {
      const rows = await resolvePlatformTransaction(ownerTransaction).query<UserRow>(
        `SELECT subject.subject_ref AS "userRef",subject.state AS status,
                GREATEST(subject.subject_generation,subject.restriction_epoch) AS "securityEpoch"
         FROM platform.authorization_subject subject
         WHERE subject.site_ref=$1 AND subject.subject_ref=$2
           AND EXISTS (
             SELECT 1 FROM platform.authorization_product_binding binding
             WHERE binding.site_ref=subject.site_ref AND binding.environment=$3
               AND binding.region=$4 AND binding.state='active'
           )
         LIMIT 1`,
        [siteRef, userRef, permit.environment, permit.region],
      );
      return rows[0] === undefined ? null : user(rows[0]);
    });
  }

  listAudit(
    permit: AdminQueryPermit,
    page: Readonly<{
      before: Readonly<{ occurredAt: string; auditRef: string }> | null;
      limit: number;
    }>,
  ) {
    return this.host.adminQueryTransaction(permit, async (ownerTransaction) => {
      const values: unknown[] = [permit.environment, permit.region,
        page.before?.occurredAt ?? "9999-12-31T23:59:59.999Z",
        page.before?.auditRef ?? "ffffffff-ffff-ffff-ffff-ffffffffffff", page.limit];
      let scope = "TRUE";
      if (permit.scope.kind === "site") {
        scope = "target_site_ref=ANY($6::text[])";
        values.push([...permit.scope.siteRefs]);
      } else if (permit.scope.kind === "breakglass") {
        scope = "decision_ref::text=ANY($6::text[])";
        values.push([...permit.scope.resourceRefs]);
      }
      const rows = await resolvePlatformTransaction(ownerTransaction).query<AuditRow>(
        `SELECT decision_ref::text AS "auditRef",operation AS "actionCode",
                occurred_at AS "occurredAt"
         FROM platform.admin_command_decision
         WHERE environment=$1 AND region=$2 AND ${scope}
           AND (occurred_at,decision_ref)<($3::timestamptz,$4::uuid)
         ORDER BY occurred_at DESC,decision_ref DESC LIMIT $5`,
        values,
      );
      return Object.freeze(rows.map((row) => Object.freeze({
        auditRef: text(row.auditRef),
        actionCode: text(row.actionCode),
        occurredAt: instant(row.occurredAt),
      })));
    });
  }

  getOperator(permit: AdminQueryPermit, operatorRef: string) {
    if (permit.operation === "admin.operator.self.read" && operatorRef !== permit.operatorRef) {
      throw new Error("ADMIN_OPERATOR_SELF_SCOPE_DENIED");
    }
    return this.host.adminQueryTransaction(permit, async (ownerTransaction) => {
      const values: unknown[] = [operatorRef, permit.environment, permit.region];
      let scope = "TRUE";
      if (permit.operation !== "admin.operator.self.read" && permit.scope.kind === "site") {
        scope = `EXISTS (SELECT 1 FROM platform.admin_operator_site_scope visible_scope
          WHERE visible_scope.operator_ref=authority.operator_ref
            AND visible_scope.operator_generation=authority.operator_generation
            AND visible_scope.site_ref=ANY($4::text[]) AND visible_scope.state='active'
            AND visible_scope.expires_at>clock_timestamp())`;
        values.push([...permit.scope.siteRefs]);
      } else if (permit.operation !== "admin.operator.self.read" && permit.scope.kind === "breakglass") {
        scope = "authority.operator_ref=ANY($4::text[])";
        values.push([...permit.scope.resourceRefs]);
      }
      const rows = await resolvePlatformTransaction(ownerTransaction).query<OperatorRow>(
        `${operatorProjection()}
         WHERE authority.operator_ref=$1 AND ${scope}
         ORDER BY authority.operator_generation DESC LIMIT 1`,
        values,
      );
      return rows[0] === undefined ? null : operator(rows[0]);
    });
  }

  listOperators(
    permit: AdminQueryPermit,
    page: Readonly<{ afterOperatorRef: string | null; limit: number }>,
  ) {
    return this.host.adminQueryTransaction(permit, async (ownerTransaction) => {
      const values: unknown[] = [page.afterOperatorRef ?? "", permit.environment, permit.region, page.limit];
      let scope = "TRUE";
      if (permit.scope.kind === "site") {
        scope = `EXISTS (SELECT 1 FROM platform.admin_operator_site_scope visible_scope
          WHERE visible_scope.operator_ref=admin_operator_authority.operator_ref
            AND visible_scope.operator_generation=admin_operator_authority.operator_generation
            AND visible_scope.site_ref=ANY($5::text[]) AND visible_scope.state='active'
            AND visible_scope.expires_at>clock_timestamp())`;
        values.push([...permit.scope.siteRefs]);
      } else if (permit.scope.kind === "breakglass") {
        scope = "operator_ref=ANY($5::text[])";
        values.push([...permit.scope.resourceRefs]);
      }
      const rows = await resolvePlatformTransaction(ownerTransaction).query<OperatorRow>(
        `WITH latest AS (
           SELECT DISTINCT ON (operator_ref) * FROM platform.admin_operator_authority
           WHERE operator_ref>$1 AND ${scope} ORDER BY operator_ref,operator_generation DESC
         )
         ${operatorProjection("latest")}
         ORDER BY authority.operator_ref ASC LIMIT $4`,
        values,
      );
      return Object.freeze(rows.map(operator));
    });
  }

  listPendingApprovals(
    permit: AdminQueryPermit,
    input: Readonly<{ siteRef: string | null;
      before: AdminPendingApprovalCursor | null; limit: number }>,
  ) {
    if (input.siteRef !== null) requireSiteAccess(permit, input.siteRef);
    return this.host.adminQueryTransaction(permit, async (ownerTransaction) => {
      const values: unknown[] = [permit.environment, permit.region,
        input.before?.admittedAt ?? null, input.before?.owner ?? null,
        input.before?.approvalRef ?? null, input.limit];
      let scope = "TRUE";
      if (input.siteRef !== null) { scope = "approval.target_site_ref=$7"; values.push(input.siteRef); }
      else if (permit.scope.kind === "site") {
        scope = "approval.target_site_ref=ANY($7::TEXT[])"; values.push([...permit.scope.siteRefs]);
      } else if (permit.scope.kind === "breakglass") {
        scope = "(approval.owner || ':' || approval.approval_ref::TEXT)=ANY($7::TEXT[])";
        values.push([...permit.scope.resourceRefs]);
      }
      const rows = await resolvePlatformTransaction(ownerTransaction).query<ApprovalRow>(
        `WITH pending_approval AS (
           SELECT 'generic_admin'::TEXT AS owner,approval.approval_ref,approval.operation,approval.maker_ref,
                  approval.target_site_ref,approval.environment,approval.region,
                  approval.operator_reason,approval.admitted_at,approval.expires_at
           FROM platform.admin_approval approval
           WHERE approval.state='pending' AND approval.expires_at>clock_timestamp()
           UNION ALL
           SELECT 'site_lifecycle'::TEXT AS owner,approval.approval_ref,approval.operation,
                  approval.maker_subject_ref AS maker_ref,approval.site_ref AS target_site_ref,
                  approval.environment,approval.region,
                  approval.reason AS operator_reason,
                  approval.requested_at AS admitted_at,approval.expires_at
           FROM platform.site_effect_approval approval
           WHERE approval.state='pending' AND approval.expires_at>clock_timestamp()
         )
         SELECT approval.owner,approval.approval_ref::TEXT AS "approvalRef",approval.operation,
                approval.maker_ref AS "makerRef",approval.target_site_ref AS "targetSiteRef",
                approval.environment,approval.region,approval.operator_reason AS "operatorReason",
                to_char(approval.admitted_at AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "admittedAt",
                to_char(approval.expires_at AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "expiresAt"
         FROM pending_approval approval
         WHERE approval.environment=$1 AND approval.region=$2 AND ${scope}
           AND ($3::timestamptz IS NULL OR
             (approval.admitted_at,approval.owner,approval.approval_ref)<
             ($3::timestamptz,$4::TEXT,$5::uuid))
         ORDER BY approval.admitted_at DESC,approval.owner DESC,approval.approval_ref DESC LIMIT $6`,
        values,
      );
      return Object.freeze(rows.map(approval));
    });
  }
}

function operatorProjection(authoritySource = "platform.admin_operator_authority"): string {
  return `SELECT authority.operator_ref AS "operatorRef",
    authority.operator_generation AS "operatorGeneration",authority.state,
    CASE WHEN authority.state='active' AND authority.expires_at>clock_timestamp()
      THEN authority.permissions ELSE ARRAY[]::text[] END AS "effectivePermissions",
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'siteId',scope.site_ref,'environment',scope.environment,'region',scope.region,
      'scopeEpoch',scope.scope_epoch::text,'expiresAt',scope.expires_at
    ) ORDER BY scope.site_ref)
      FROM platform.admin_operator_site_scope scope
      WHERE scope.operator_ref=authority.operator_ref
        AND scope.operator_generation=authority.operator_generation
        AND scope.environment=$2 AND scope.region=$3
        AND scope.state='active' AND scope.expires_at>clock_timestamp()),'[]'::jsonb)
      AS "effectiveSiteScopes",
    authority.operator_security_epoch AS "operatorSecurityEpoch",
    authority.authorization_epoch AS "authorizationEpoch",authority.expires_at AS "expiresAt"
    FROM ${authoritySource} authority`;
}

function deploymentFence(): string {
  return `EXISTS (
    SELECT 1 FROM platform.site_deployment_binding deployment
    WHERE deployment.site_ref=site.site_ref AND deployment.environment=$2
      AND deployment.region=$3 AND deployment.state='active'
  )`;
}

function allowedSiteRefs(permit: AdminQueryPermit): readonly string[] | null {
  if (permit.scope.kind === "global") return null;
  if (permit.scope.kind === "site") return permit.scope.siteRefs;
  return permit.scope.resourceRefs;
}

function requireSiteAccess(permit: AdminQueryPermit, siteRef: string): void {
  const allowed = allowedSiteRefs(permit);
  if (allowed !== null && !allowed.includes(siteRef)) throw new Error("ADMIN_SITE_SCOPE_DENIED");
}

function site(row: SiteRow) {
  return Object.freeze({
    siteRef: text(row.siteRef),
    status: text(row.status),
    securityEpoch: positive(row.securityEpoch),
  });
}

function user(row: UserRow) {
  return Object.freeze({
    userRef: text(row.userRef),
    status: text(row.status),
    securityEpoch: positive(row.securityEpoch),
  });
}

function operator(row: OperatorRow) {
  if (!(["active", "suspended", "revoked"] as const).includes(row.state as never)) {
    throw new Error("ADMIN_QUERY_ROW_CORRUPT");
  }
  const permissions = stringArray(row.effectivePermissions);
  const scopes = jsonArray(row.effectiveSiteScopes).map((value) => {
    const scope = jsonRecord(value);
    return Object.freeze({ siteId: text(scope.siteId), environment: text(scope.environment),
      region: text(scope.region), scopeEpoch: positive(scope.scopeEpoch), expiresAt: instant(scope.expiresAt) });
  });
  return Object.freeze({ operatorRef: text(row.operatorRef), operatorGeneration: positive(row.operatorGeneration),
    state: row.state as "active" | "suspended" | "revoked", effectivePermissions: permissions,
    effectiveSiteScopes: Object.freeze(scopes), operatorSecurityEpoch: positive(row.operatorSecurityEpoch),
    authorizationEpoch: positive(row.authorizationEpoch), expiresAt: instant(row.expiresAt) });
}

function approval(row: ApprovalRow) {
  return Object.freeze({ owner: approvalOwner(row.owner), approvalRef: uuid(row.approvalRef),
    operation: text(row.operation),
    makerRef: text(row.makerRef), targetSiteRef: row.targetSiteRef === null ? null : text(row.targetSiteRef),
    environment: text(row.environment), region: text(row.region), operatorReason: text(row.operatorReason),
    admittedAt: preciseInstant(row.admittedAt), expiresAt: preciseInstant(row.expiresAt) });
}

function approvalOwner(value: unknown): AdminPendingApprovalOwner {
  if (value !== "generic_admin" && value !== "site_lifecycle") {
    throw new Error("ADMIN_QUERY_ROW_CORRUPT");
  }
  return value;
}

function uuid(value: unknown): string {
  const result = text(value);
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(result)) {
    throw new Error("ADMIN_QUERY_ROW_CORRUPT");
  }
  return result;
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.length < 1) throw new Error("ADMIN_QUERY_ROW_CORRUPT");
  return value;
}

function positive(value: unknown): bigint {
  const result = typeof value === "bigint" ? value : typeof value === "string" ? BigInt(value) : 0n;
  if (result < 1n) throw new Error("ADMIN_QUERY_ROW_CORRUPT");
  return result;
}

function instant(value: unknown): string {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (date === null || !Number.isFinite(date.getTime())) throw new Error("ADMIN_QUERY_ROW_CORRUPT");
  return date.toISOString();
}

function preciseInstant(value: unknown): string {
  const result = text(value);
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{6})Z$/u.exec(result);
  if (match === null) throw new Error("ADMIN_QUERY_ROW_CORRUPT");
  const base = match[1]!;
  const microseconds = match[2]!;
  const millisecondsText = `${base}.${microseconds.slice(0, 3)}Z`;
  const milliseconds = Date.parse(millisecondsText);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== millisecondsText) {
    throw new Error("ADMIN_QUERY_ROW_CORRUPT");
  }
  return result;
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length < 1)) {
    throw new Error("ADMIN_QUERY_ROW_CORRUPT");
  }
  return Object.freeze([...value].sort());
}
function jsonArray(value: unknown): readonly unknown[] {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(parsed)) throw new Error("ADMIN_QUERY_ROW_CORRUPT");
  return parsed;
}
function jsonRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("ADMIN_QUERY_ROW_CORRUPT");
  }
  return value as Record<string, unknown>;
}
