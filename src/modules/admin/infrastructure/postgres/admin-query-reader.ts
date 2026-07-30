import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import { resolvePlatformTransaction } from
  "../../../../shared/unit-of-work/platform-transaction.js";
import type {
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
