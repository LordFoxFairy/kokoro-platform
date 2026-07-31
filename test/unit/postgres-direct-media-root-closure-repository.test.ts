import { describe, expect, it, vi } from "vitest";
import { PostgresDirectMediaRootClosureRepository } from
  "../../src/modules/credit/infrastructure/postgres/direct-media-root-closure-repository.js";
import { issuePlatformTransaction, revokePlatformTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";
import type { PlatformSqlTransaction } from "../../src/shared/unit-of-work/platform-transaction.js";

describe("PostgreSQL Direct Media root closure adapter", () => {
  it("uses only the exact worker-to-Credit definer routines", async () => {
    const query = vi.fn(async (statement: string) => statement.includes("find_direct_media_root_closure")
      ? [{ result: { kind: "none" } }] : [{ result: null }]);
    const lease = issuePlatformTransaction({ query: query as unknown as PlatformSqlTransaction["query"],
      execute: async () => 0 });
    const repository = new PostgresDirectMediaRootClosureRepository();
    try {
      await expect(repository.findClosure(lease.transaction, {
        siteId: "site:one", operationRef: "media:one",
        businessOperationKey: "close:one", requestDigest: "a".repeat(64),
        workerLease: { taskRef: "task:one", leaseEpoch: 7n, leaseTokenHash: "b".repeat(64) },
      })).resolves.toEqual({ kind: "none" });
      await repository.lockRootClosure(lease.transaction, {
        siteId: "site:one", operationRef: "media:one",
        executionBudgetRootRef: "00000000-0000-7000-8000-000000000001",
        rootAllocationRef: "00000000-0000-7000-8000-000000000002",
        rootHoldRef: "00000000-0000-7000-8000-000000000003",
        authorizationSegmentRef: "00000000-0000-7000-8000-000000000004",
        settlementRef: "00000000-0000-7000-8000-000000000005",
        executionManifestRef: "manifest:one", rootAllocationRevision: 2n,
        rootAllocationEpoch: 1n, authorizationSegmentVersion: 5n,
        reservedCeiling: 100n, unit: "credit_micros",
        workerLease: { taskRef: "task:one", leaseEpoch: 7n, leaseTokenHash: "b".repeat(64) },
      });
      expect(query).toHaveBeenCalledTimes(2);
      for (const [statement] of query.mock.calls) {
        expect(statement).toMatch(/SELECT platform\.(?:find|lock)_direct_media_root_closure/u);
        expect(statement).not.toMatch(/FROM platform\.credit_|UPDATE platform\.credit_|INSERT INTO platform\.credit_/u);
      }
    } finally { revokePlatformTransaction(lease); }
  });
});
