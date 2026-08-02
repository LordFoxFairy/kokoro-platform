import { describe, expect, it, vi } from "vitest";
import { PostgresExecutionRootClosureRepository } from
  "../../src/modules/credit/infrastructure/postgres/execution-root-closure-repository.js";
import { issuePlatformTransaction, revokePlatformTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";
import type { PlatformSqlTransaction } from "../../src/shared/unit-of-work/platform-transaction.js";
import { verifyMediaExecutionRootOwnerProof } from
  "../../src/modules/credit/application/contracts/execution-root-closure-repository.js";

const ownerProof = () => verifyMediaExecutionRootOwnerProof({
  sourceRef: "media:one", terminalEvidenceRef: "terminal:one", outcome: "completed",
  workerLease: { taskRef: "task:one", leaseEpoch: 7n, leaseTokenHash: "b".repeat(64) },
});

describe("PostgreSQL execution root closure adapter", () => {
  it("maps an exact durable reconciliation lookup without mistaking its receipt for an allocation revision", async () => {
    const reconciliationReceiptRef = "00000000-0000-7000-8000-000000000100";
    const query = vi.fn(async () => [{ result: {
      kind: "reconciliation_required",
      reconciliationReceiptRef,
      code: "CREDIT_DIRECT_ROOT_RATING_MISMATCH",
    } }]);
    const lease = issuePlatformTransaction({ query: query as unknown as PlatformSqlTransaction["query"],
      execute: async () => 0 });
    const repository = new PostgresExecutionRootClosureRepository();
    try {
      await expect(repository.findClosure(lease.transaction, {
        siteId: "site:one", ownerProof: ownerProof(),
        businessOperationKey: "close:one", requestDigest: "a".repeat(64),
      })).resolves.toEqual({ kind: "reconciliation_required", reconciliationReceiptRef,
        code: "CREDIT_DIRECT_ROOT_RATING_MISMATCH" });
    } finally { revokePlatformTransaction(lease); }
  });

  it("uses only the exact worker-to-Credit definer routines", async () => {
    const query = vi.fn(async (statement: string) => statement.includes("find_execution_root_closure")
      ? [{ result: { kind: "none" } }] : [{ result: null }]);
    const lease = issuePlatformTransaction({ query: query as unknown as PlatformSqlTransaction["query"],
      execute: async () => 0 });
    const repository = new PostgresExecutionRootClosureRepository();
    try {
      await expect(repository.findClosure(lease.transaction, {
        siteId: "site:one", ownerProof: ownerProof(),
        businessOperationKey: "close:one", requestDigest: "a".repeat(64),
      })).resolves.toEqual({ kind: "none" });
      await repository.lockRootClosure(lease.transaction, {
        identity: { siteId: "site:one", ownerProof: ownerProof(),
          businessOperationKey: "close:one", requestDigest: "a".repeat(64) },
        settlementRef: "00000000-0000-7000-8000-000000000005",
        budget: { executionBudgetRootRef: "00000000-0000-7000-8000-000000000001",
          rootAllocationRef: "00000000-0000-7000-8000-000000000002",
          rootHoldRef: "00000000-0000-7000-8000-000000000003",
          authorizationSegmentRef: "00000000-0000-7000-8000-000000000004",
          executionManifestRef: "manifest:one", rootAllocationRevision: 2n,
          rootAllocationEpoch: 1n, authorizationSegmentVersion: 5n,
          reservedCeiling: 100n, unit: "credit_micros" },
      });
      expect(query).toHaveBeenCalledTimes(2);
      for (const [statement] of query.mock.calls) {
        expect(statement).toMatch(/SELECT platform\.(?:find|lock)_execution_root_closure/u);
        expect(statement).not.toMatch(/FROM platform\.credit_|UPDATE platform\.credit_|INSERT INTO platform\.credit_/u);
      }
    } finally { revokePlatformTransaction(lease); }
  });
});
