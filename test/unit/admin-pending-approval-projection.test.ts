import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { PostgresAdminQueryReader } from
  "../../src/modules/admin/infrastructure/postgres/admin-query-reader.js";
import type { AdminQueryPermit } from
  "../../src/modules/admin/interfaces/connect/admin-query-service.js";
import {
  issuePlatformTransaction,
  revokePlatformTransaction,
} from "../../src/shared/unit-of-work/platform-transaction.js";

const migration = readFileSync(new URL(
  "../../prisma/migrations/20260824_admin_pending_approval_projection/migration.sql",
  import.meta.url,
), "utf8");
const prismaSchema = readFileSync(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");

const permit: AdminQueryPermit = Object.freeze({
  operatorRef: "operator:reader",
  environment: "production",
  region: "us-east-1",
  operation: "admin.approval.list",
  authorityBindingDigest: "a".repeat(64),
  scope: Object.freeze({ kind: "site", siteRefs: Object.freeze(["site:alpha"]) }),
});

describe("Admin pending approval projection", () => {
  it("hard-cuts lifecycle approval identity and axes without merging owner tables", () => {
    expect(migration).toContain("ALTER COLUMN approval_ref TYPE UUID");
    expect(migration).toContain("ADD COLUMN environment TEXT NOT NULL");
    expect(migration).toContain("ADD COLUMN region TEXT NOT NULL");
    expect(migration).toContain("admin_approval_non_lifecycle");
    for (const operation of [
      "site.activation.begin",
      "site.traffic-stop.suspend",
      "site.traffic-stop.decommission",
    ]) expect(migration).toContain(`'${operation}'`);
    expect(migration).not.toContain("SECURITY DEFINER");
    expect(migration).not.toMatch(/CREATE\s+(?:MATERIALIZED\s+)?VIEW/iu);
    for (const index of [
      "admin_approval_pending_projection_idx",
      "site_effect_approval_pending_projection_idx",
    ]) expect(prismaSchema).toContain(`map: "${index}"`);
  });

  it("adds exact fail-closed AdminQuery SELECT policies to both owners", () => {
    expect(migration).toContain(
      "DROP POLICY site_effect_approval_scope ON platform.site_effect_approval",
    );
    expect(migration).toContain("CREATE POLICY admin_approval_query_read");
    expect(migration).toContain("CREATE POLICY site_effect_approval_admin_query_read");
    for (const policy of ["admin_approval_query_read", "site_effect_approval_admin_query_read"]) {
      const body = policyBody(policy);
      expect(body).toContain("current_setting('app.operation',true)='admin.approval.list'");
      expect(body).toContain("current_setting('app.workload_kind',true)='platform_admin'");
      expect(body).toContain("current_setting('app.actor_kind',true)='operator'");
      for (const scope of ["global", "site", "breakglass"]) {
        expect(body).toContain(`current_setting('app.admin_scope_kind',true)='${scope}'`);
      }
    }
    expect(migration).toContain("environment=current_setting('app.environment',true)");
    expect(migration).toContain("region=current_setting('app.region',true)");
    expect(migration).toContain("'generic_admin:' || approval_ref::TEXT");
    expect(migration).toContain("'site_lifecycle:' || approval_ref::TEXT");
    expect(migration).not.toContain("current_setting('app.workload_kind',true)='platform_worker'");
  });

  it("gives Site approval request, approve and consume exact operator policies", () => {
    for (const policy of [
      "site_effect_approval_request_insert",
      "site_effect_approval_request_read",
      "site_effect_approval_approve_update",
      "site_effect_approval_approve_read",
      "site_effect_approval_consume_update",
      "site_effect_approval_consume_read",
    ]) expect(migration).toContain(`CREATE POLICY ${policy}`);
    for (const operation of [
      "site.approval.request",
      "site.approval.approve",
      "site.activation.begin",
      "site.traffic-stop.request",
    ]) expect(migration).toContain(`'${operation}'`);
    expect(migration).toContain("current_setting('app.workload_kind',true)='admin_workload'");
    expect(migration).toContain("current_setting('app.actor_kind',true)='operator'");
    const consumeRead = policyBody("site_effect_approval_consume_read");
    expect(consumeRead).toContain("state='approved' AND expires_at>clock_timestamp()");
    expect(consumeRead).toContain(
      "state='consumed' AND consumed_request_id IS NOT NULL AND consumed_at IS NOT NULL",
    );
  });

  it("freezes checker, decision and consumption evidence once written", () => {
    for (const field of [
      "OLD.checker_subject_ref",
      "OLD.decided_at",
      "OLD.consumed_request_id",
      "OLD.consumed_at",
    ]) expect(migration).toContain(field);
    expect(migration).toContain("SITE_EFFECT_APPROVAL_CHECKER_EVIDENCE_IMMUTABLE");
    expect(migration).toContain("SITE_EFFECT_APPROVAL_CONSUMPTION_EVIDENCE_IMMUTABLE");
  });

  it("reads an owner-qualified, microsecond keyset across independent approval owners", async () => {
    const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
    const lease = issuePlatformTransaction({
      execute: async () => 0,
      query: async <Row extends Record<string, unknown>>(
        sql: string,
        values: readonly unknown[] = [],
      ) => {
        statements.push({ sql, values });
        return [
          {
            owner: "generic_admin",
            approvalRef: "10000000-0000-4000-8000-000000000001",
            operation: "admin.authority.change",
            makerRef: "operator:generic",
            targetSiteRef: "site:alpha",
            environment: "production",
            region: "us-east-1",
            operatorReason: "generic change",
            admittedAt: "2026-08-08T01:00:00.123456Z",
            expiresAt: "2026-08-08T01:10:00.654321Z",
          },
          {
            owner: "site_lifecycle",
            approvalRef: "10000000-0000-4000-8000-000000000001",
            operation: "site.activation.begin",
            makerRef: "operator:lifecycle",
            targetSiteRef: "site:alpha",
            environment: "production",
            region: "us-east-1",
            operatorReason: "activate release",
            admittedAt: "2026-08-08T01:00:00.123123Z",
            expiresAt: "2026-08-08T01:09:00.000001Z",
          },
        ] as unknown as readonly Row[];
      },
    });
    const reader = new PostgresAdminQueryReader({
      adminQueryTransaction: async (_permit, work) => work(lease.transaction),
    });

    try {
      await expect(reader.listPendingApprovals(permit, {
        siteRef: "site:alpha",
        before: {
          admittedAt: "2026-08-08T02:00:00.000000Z",
          owner: "site_lifecycle",
          approvalRef: "ffffffff-ffff-4fff-bfff-ffffffffffff",
        },
        limit: 101,
      })).resolves.toEqual([
        expect.objectContaining({
          owner: "generic_admin",
          approvalRef: "10000000-0000-4000-8000-000000000001",
          operation: "admin.authority.change",
        }),
        expect.objectContaining({
          owner: "site_lifecycle",
          approvalRef: "10000000-0000-4000-8000-000000000001",
          operation: "site.activation.begin",
        }),
      ]);
    } finally {
      revokePlatformTransaction(lease);
    }

    expect(statements).toHaveLength(1);
    const statement = statements[0]!;
    expect(statement.sql).toContain("FROM platform.admin_approval");
    expect(statement.sql).toContain("UNION ALL");
    expect(statement.sql).toContain("FROM platform.site_effect_approval");
    expect(statement.sql).toContain("'generic_admin'::TEXT AS owner");
    expect(statement.sql).toContain("'site_lifecycle'::TEXT AS owner");
    expect(statement.sql).toContain("approval.reason AS operator_reason");
    expect(statement.sql).toContain("approval.requested_at AS admitted_at");
    expect(statement.sql).toContain("YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"");
    expect(statement.sql).toMatch(
      /\(approval\.admitted_at,approval\.owner,approval\.approval_ref\)<\s*\(\$3::timestamptz,\$4::TEXT,\$5::uuid\)/u,
    );
    expect(statement.sql).toContain(
      "ORDER BY approval.admitted_at DESC,approval.owner DESC,approval.approval_ref DESC",
    );
    expect(statement.sql).not.toContain("site_deployment_binding");
    expect(statement.values).toEqual([
      "production",
      "us-east-1",
      "2026-08-08T02:00:00.000000Z",
      "site_lifecycle",
      "ffffffff-ffff-4fff-bfff-ffffffffffff",
      101,
      "site:alpha",
    ]);
  });
});

function policyBody(name: string): string {
  const match = new RegExp(
    `CREATE POLICY ${name}\\s+[\\s\\S]*?(?=\\nCREATE POLICY|$)`,
    "u",
  ).exec(migration);
  expect(match, name).not.toBeNull();
  return match![0];
}
