import { describe, expect, it } from "vitest";
import { PostgresAdminAuthorityRepository } from
  "../../src/modules/admin-control/infrastructure/postgres/admin-authority-repository.js";
import {
  issuePlatformTransaction,
  revokePlatformTransaction,
  type PlatformSqlTransaction,
} from "../../src/shared/unit-of-work/platform-transaction.js";

describe("PostgresAdminAuthorityRepository", () => {
  it("locks the exact operator generation and maps the current authority epoch", async () => {
    const statements: string[] = [];
    const lease = issuePlatformTransaction({
      execute: async () => 1,
      query: async (statement) => {
        statements.push(statement);
        return [{ operatorRef: "operator_01", operatorGeneration: 3n, state: "active",
          permissions: ["site.lifecycle.suspend"], siteScopes: ["site_01"],
          globalScopes: ["018f1515-1515-7515-8515-151515151515"],
          environments: ["production"], regions: ["us-east-1"], authorizationEpoch: 9n,
          expiresAt: new Date("2026-07-28T14:00:00.000Z"), breakGlassExpiresAt: null }] as never;
      },
    });
    try {
      await expect(new PostgresAdminAuthorityRepository().lockOperatorAuthority(lease.transaction,
        { operatorRef: "operator_01", operatorGeneration: 3n })).resolves.toMatchObject({
        operatorGeneration: 3n, authorizationEpoch: 9n,
      });
      expect(statements[0]).toContain("operator_generation=$2");
      expect(statements[0]).toContain("FOR UPDATE");
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("uses a revision CAS for the only mutable approval transition", async () => {
    const statements: string[] = [];
    const values: readonly unknown[][] = [];
    const sql: PlatformSqlTransaction = {
      query: async () => [],
      execute: async (statement, parameters = []) => {
        statements.push(statement);
        (values as unknown[][]).push([...parameters]);
        return 1;
      },
    };
    const lease = issuePlatformTransaction(sql);
    try {
      await expect(new PostgresAdminAuthorityRepository().transitionApproval(lease.transaction, {
        approvalRef: "018f1414-1414-7414-8414-141414141414", expectedRevision: 4n,
        state: "executed", result: { ok: true }, resultDigest: "a".repeat(64),
        checker: {
          approvalRef: "018f1414-1414-7414-8414-141414141414",
          commandId: "018f1212-1212-7212-8212-121212121212",
          ownerOperation: "site.suspend",
          checkerRef: "checker_01", checkerGeneration: 4n, checkerAuthorizationEpoch: 11n,
          makerRef: "maker_01", makerGeneration: 2n, makerAuthorizationEpoch: 8n,
          siteRef: "site_01", environment: "production", region: "us-east-1",
          decision: "approve", reason: "independent approval",
          admittedAt: "2026-07-28T13:00:00.000Z",
        },
      })).resolves.toBe(true);
      expect(statements[0]).toContain("state='pending' AND revision=$11");
      expect(statements[0]).toContain("revision=revision+1");
      expect(values[0]?.[10]).toBe(4n);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("terminalizes dead-lettered or missing execution events instead of leaving approvals queued", async () => {
    const statements: string[] = [];
    const lease = issuePlatformTransaction({
      query: async () => [],
      execute: async (statement) => { statements.push(statement); return 1; },
    });
    try {
      await expect(new PostgresAdminAuthorityRepository().terminalizeApprovals(
        lease.transaction, "2026-07-29T12:00:00.000Z",
      )).resolves.toBe(2);
      expect(statements[1]).toContain("approval.state='execution_queued'");
      expect(statements[1]).toContain("event.state IN ('pending','leased')");
      expect(statements[1]).toContain("ADMIN_EXECUTION_ORPHANED");
    } finally {
      revokePlatformTransaction(lease);
    }
  });
});
