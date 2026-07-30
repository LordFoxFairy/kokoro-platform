import { describe, expect, it } from "vitest";
import { PostgresModelControlAdminReader } from
  "../../src/modules/model-control/infrastructure/postgres/model-control-admin-reader.js";
import {
  issuePlatformTransaction,
  revokePlatformTransaction,
} from "../../src/shared/unit-of-work/platform-transaction.js";
import type { AdminQueryPermit } from
  "../../src/modules/admin/interfaces/connect/admin-query-service.js";
import type { PlatformTransaction } from "../../src/shared/unit-of-work/index.js";

const globalPermit: AdminQueryPermit = Object.freeze({
  operatorRef: "operator:1", environment: "production", region: "us-east-1",
  authorityBindingDigest: "b".repeat(64),
  operation: "model.inventory.read", scope: { kind: "global" as const, grantRef: "grant:global" },
});
const sitePermit: AdminQueryPermit = Object.freeze({
  operatorRef: "operator:1", environment: "production", region: "us-east-1",
  authorityBindingDigest: "b".repeat(64),
  operation: "model.site-policy.read", scope: { kind: "site" as const, siteRefs: ["site:alpha"] },
});

describe("PostgresModelControlAdminReader", () => {
  it("projects provider credential presence without selecting the secret reference", async () => {
    const statements: string[] = [];
    const reader = new PostgresModelControlAdminReader(host(async (statement) => {
      statements.push(statement);
      if (statement.includes("transaction_timestamp")) return [{ asOf: "2026-07-30T12:00:00.000Z" }];
      return [{ providerKey: "provider-a", provider: "openai", accountKey: "primary",
        adapterKind: "litellm", priority: 0, secretReferencePresent: true,
        status: "active", health: "healthy", availabilityEpoch: 4n,
        observedAt: "2026-07-30T11:59:00.000Z" }];
    }));

    const result = await reader.listInventoryProviders(globalPermit, "a".repeat(64), {
      afterProviderKey: null, limit: 51, asOf: null,
    });

    expect(result.items[0]).toMatchObject({ providerKey: "provider-a", secretReferencePresent: true });
    const projection = statements.find((statement) => statement.includes("model_provider_snapshot"))!;
    expect(projection).toContain('secret_ref IS NOT NULL AS "secretReferencePresent"');
    expect(projection).not.toMatch(/SELECT[\s\S]*provider\.secret_ref\s*(?:,|AS)/u);
  });

  it("uses the exact-Site transaction fence for Site policies", async () => {
    const calls: string[] = [];
    const reader = new PostgresModelControlAdminReader({
      adminQueryTransaction: async () => { calls.push("global"); throw new Error("wrong transaction"); },
      adminSiteQueryTransaction: async (_permit, siteRef, work) => {
        calls.push(`site:${siteRef}`);
        return withTransaction(async (statement) => statement.includes("transaction_timestamp")
          ? [{ asOf: "2026-07-30T12:00:00.000Z" }]
          : [] as Record<string, unknown>[], work);
      },
    });

    await expect(reader.listSiteModelPolicies(sitePermit, "site:alpha", {
      before: null, limit: 51, asOf: null,
    })).resolves.toMatchObject({ items: [], asOf: "2026-07-30T12:00:00.000Z" });
    expect(calls).toEqual(["site:site:alpha"]);
  });
});

function host(query: (statement: string) => Promise<readonly Record<string, unknown>[]>) {
  return {
    adminQueryTransaction: async <Result>(_permit: AdminQueryPermit,
      work: (transaction: PlatformTransaction) => Promise<Result>) => withTransaction(query, work),
    adminSiteQueryTransaction: async () => { throw new Error("unexpected Site transaction"); },
  } as ConstructorParameters<typeof PostgresModelControlAdminReader>[0];
}

async function withTransaction<Result>(query: (statement: string) => Promise<readonly Record<string, unknown>[]>,
  work: (transaction: PlatformTransaction) => Promise<Result>) {
  const lease = issuePlatformTransaction({
    query: async <Row extends Record<string, unknown>>(statement: string) =>
      await query(statement) as readonly Row[],
    execute: async () => 0,
  });
  try { return await work(lease.transaction); } finally { revokePlatformTransaction(lease); }
}
