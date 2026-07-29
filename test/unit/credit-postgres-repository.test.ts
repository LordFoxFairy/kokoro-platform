import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { RootBudgetReservationRecord, StoredSegmentAllocation } from
  "../../src/modules/credit/application/contracts/credit-authority-repository.js";
import { PostgresCreditAuthorityRepository } from
  "../../src/modules/credit/infrastructure/postgres/credit-authority-repository.js";
import { issuePlatformTransaction, revokePlatformTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";

describe("PostgresCreditAuthorityRepository", () => {
  it("replays the persisted typed result and rejects a changed request digest", async () => {
    const sql = new RecordingSql();
    sql.queryResults.push([receiptRow("a".repeat(64))], [receiptRow("a".repeat(64))]);
    const lease = issuePlatformTransaction(sql);
    try {
      const repository = new PostgresCreditAuthorityRepository();
      const identity = { siteId: "site-1", operationKind: "reserve_root" as const,
        businessOperationKey: "reserve:run-1", requestDigest: "a".repeat(64) };
      await expect(repository.findOperationReceipt(lease.transaction, identity)).resolves.toMatchObject({
        kind: "replayed", value: { state: "reserved", segmentVersion: 1n },
      });
      await expect(repository.findOperationReceipt(lease.transaction, {
        ...identity, requestDigest: "b".repeat(64),
      })).resolves.toEqual({ kind: "conflict", code: "REQUEST_DIGEST_CONFLICT" });
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("atomically records reserve journal, budget facts, outbox and exactly-once receipt", async () => {
    const sql = new RecordingSql();
    sql.queryResults.push([]);
    const lease = issuePlatformTransaction(sql);
    try {
      const repository = postgresRepository();
      const result = await repository.createRootBudgetReservation(lease.transaction, reservation());
      expect(result).toMatchObject({ kind: "accepted", value: { state: "reserved" } });
      expect(sql.writeSql()).toContain("INSERT INTO platform.credit_hold");
      expect(sql.writeSql()).toContain("INSERT INTO platform.credit_journal_transaction");
      expect(sql.writeSql()).toContain("INSERT INTO platform.credit_journal_entry");
      expect(sql.writeSql()).toContain("INSERT INTO platform.credit_execution_budget_root");
      expect(sql.writeSql()).toContain("INSERT INTO platform.credit_authorization_segment");
      expect(sql.writeSql()).toContain("INSERT INTO platform.outbox_event");
      expect(sql.writeSql()).toContain("INSERT INTO platform.credit_budget_operation_receipt");
      expect(sql.indexOf("platform.outbox_event")).toBeLessThan(sql.indexOf("platform.credit_budget_operation_receipt"));

      const journal = sql.writes.find((write) => write.statement.includes("credit_journal_transaction"));
      const expectedCanonical = [
        "0|site-1|00000000-0000-7000-8000-000000000001|credit_micros|debit|customer_available|40|00000000-0000-7000-8000-000000000101|00000000-0000-7000-8000-000000000201",
        "1|site-1|00000000-0000-7000-8000-000000000001|credit_micros|credit|customer_reserved|40|00000000-0000-7000-8000-000000000101|00000000-0000-7000-8000-000000000201",
        "2|site-1|00000000-0000-7000-8000-000000000001|credit_micros|debit|customer_available|20|00000000-0000-7000-8000-000000000102|00000000-0000-7000-8000-000000000201",
        "3|site-1|00000000-0000-7000-8000-000000000001|credit_micros|credit|customer_reserved|20|00000000-0000-7000-8000-000000000102|00000000-0000-7000-8000-000000000201",
      ].join("\n");
      expect(journal?.values?.[7]).toBe(createHash("sha256").update(expectedCanonical).digest("hex"));
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("serializes the CreditAccount before taking a fresh grant-balance snapshot", async () => {
    const sql = new RecordingSql();
    sql.accountRows = [{ creditAccountId: "00000000-0000-7000-8000-000000000001" }];
    sql.grantRows = [{ creditGrantId: "00000000-0000-7000-8000-000000000101",
      availableAmount: "60", expiresAt: null, burnPriority: 10, issuedAt: NOW }];
    const lease = issuePlatformTransaction(sql);
    try {
      const result = await postgresRepository().lockGrantAvailability(lease.transaction, {
        siteId: "site-1", billingAccountId: "billing-1",
        creditAccountId: "00000000-0000-7000-8000-000000000001", unit: "credit_micros",
        liabilityMerchantAccountId: "merchant-1", effectiveAt: NOW,
      });
      expect(result).toMatchObject([{ availableAmount: 60n }]);
      expect(sql.readSql()).toMatch(/pg_advisory_xact_lock[\s\S]+FROM platform.credit_account[\s\S]+FOR UPDATE[\s\S]+FROM platform.credit_grant[\s\S]+available_amount/u);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("commits allocation CAS, Segment CAS, event and receipt in one supplied transaction", async () => {
    const sql = new RecordingSql();
    sql.queryResults.push([]);
    const lease = issuePlatformTransaction(sql);
    try {
      const result = await postgresRepository().commitAuthorizationSegment(
        lease.transaction, storedSegment("committed"), operation("finalize_segment"), NOW,
      );
      expect(result).toMatchObject({ kind: "accepted", value: { state: "committed", segmentVersion: 2n } });
      expect(sql.writeSql()).toMatch(/credit_budget_allocation_revision[\s\S]+credit_authorization_segment[\s\S]+outbox_event[\s\S]+credit_budget_operation_receipt/u);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("releases only a reserved Segment and persists the operation evidence atomically", async () => {
    const sql = new RecordingSql();
    sql.queryResults.push([]);
    const lease = issuePlatformTransaction(sql);
    try {
      const result = await postgresRepository().releaseAuthorizationSegment(
        lease.transaction, storedSegment("released"), operation("release_segment"), NOW,
      );
      expect(result).toMatchObject({ kind: "accepted", value: { state: "released" } });
      expect(sql.writeSql()).not.toContain("INSERT INTO platform.credit_budget_allocation_revision");
      expect(sql.writeSql()).toMatch(/credit_authorization_segment[\s\S]+outbox_event[\s\S]+credit_budget_operation_receipt/u);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("fences unknown outcomes across Segment, Root and Hold before publishing reconciliation", async () => {
    const sql = new RecordingSql();
    sql.queryResults.push([]);
    const lease = issuePlatformTransaction(sql);
    try {
      const result = await postgresRepository().markAuthorizationSegmentReconciliationRequired(
        lease.transaction, storedSegment("reconciliation_required"), operation("reconcile_segment"), NOW,
      );
      expect(result).toMatchObject({ kind: "reconciliation_required", value: { segmentVersion: 3n } });
      expect(sql.writeSql()).toMatch(/credit_authorization_segment[\s\S]+credit_execution_budget_root[\s\S]+credit_hold[\s\S]+outbox_event[\s\S]+credit_budget_operation_receipt/u);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("aborts reconciliation evidence when the expected Root CAS does not change exactly one row", async () => {
    const sql = new RecordingSql();
    sql.queryResults.push([]);
    sql.zeroChangeFragment = "UPDATE platform.credit_execution_budget_root";
    const lease = issuePlatformTransaction(sql);
    try {
      await expect(postgresRepository().markAuthorizationSegmentReconciliationRequired(
        lease.transaction, storedSegment("reconciliation_required"), operation("reconcile_segment"), NOW,
      )).rejects.toThrowError("CREDIT_ROOT_RECONCILIATION_CAS_LOST");
      expect(sql.writeSql()).not.toContain("INSERT INTO platform.credit_budget_operation_receipt");
    } finally {
      revokePlatformTransaction(lease);
    }
  });
});

const NOW = "2026-07-29T00:00:00.000Z";

class RecordingSql {
  readonly writes: { statement: string; values?: readonly unknown[] }[] = [];
  readonly reads: { statement: string; values?: readonly unknown[] }[] = [];
  readonly queryResults: (readonly Record<string, unknown>[])[] = [];
  accountRows: readonly Record<string, unknown>[] = [];
  grantRows: readonly Record<string, unknown>[] = [];
  zeroChangeFragment: string | null = null;

  async query<Row extends Record<string, unknown>>(statement: string, values?: readonly unknown[]): Promise<readonly Row[]> {
    this.reads.push(values === undefined ? { statement } : { statement, values });
    if (statement.includes("credit_budget_operation_receipt")) {
      return (this.queryResults.shift() ?? []) as readonly Row[];
    }
    if (statement.includes("FROM platform.credit_account")) return this.accountRows as readonly Row[];
    if (statement.includes("FROM platform.credit_grant")) return this.grantRows as readonly Row[];
    return [];
  }

  async execute(statement: string, values?: readonly unknown[]): Promise<number> {
    this.writes.push(values === undefined ? { statement } : { statement, values });
    return this.zeroChangeFragment !== null && statement.includes(this.zeroChangeFragment) ? 0 : 1;
  }

  writeSql(): string { return this.writes.map((write) => write.statement).join("\n"); }
  readSql(): string { return this.reads.map((read) => read.statement).join("\n"); }
  indexOf(fragment: string): number { return this.writes.findIndex((write) => write.statement.includes(fragment)); }
}

function postgresRepository(): PostgresCreditAuthorityRepository {
  let next = 900;
  return new PostgresCreditAuthorityRepository({
    reference: () => `00000000-0000-7000-8000-${String(next++).padStart(12, "0")}`,
  });
}

function receiptRow(requestDigest: string) {
  const result = {
    executionBudgetRootRef: "00000000-0000-7000-8000-000000000202",
    creditHoldRef: "00000000-0000-7000-8000-000000000201",
    authorizationSegmentRef: "00000000-0000-7000-8000-000000000205",
    segmentVersion: "1", state: "reserved", expiresAt: "2026-07-29T00:05:00.000Z",
  };
  return { requestDigest, outcomeKind: "accepted", result,
    resultDigest: createHash("sha256").update(canonical(result)).digest("hex") };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function reservation(): RootBudgetReservationRecord {
  return {
    siteId: "site-1", billingAccountId: "billing-1",
    creditAccountId: "00000000-0000-7000-8000-000000000001", unit: "credit_micros",
    liabilityMerchantAccountId: "merchant-1", executionRootId: "run-1",
    authorizationBudgetRef: "policy-1", ratingPolicyRevisionRef: "rating-1",
    executionManifestRef: "manifest-1", businessOperationKey: "reserve:run-1",
    requestDigest: "a".repeat(64), rootCeiling: 60n, segmentMaximum: 25n,
    expiresAt: "2026-07-29T00:05:00.000Z", occurredAt: NOW,
    creditHoldRef: "00000000-0000-7000-8000-000000000201",
    executionBudgetRootRef: "00000000-0000-7000-8000-000000000202",
    rootAllocationRef: "00000000-0000-7000-8000-000000000203",
    initialAllocationRevisionRef: "00000000-0000-7000-8000-000000000204",
    authorizationSegmentRef: "00000000-0000-7000-8000-000000000205",
    reserveJournalTransactionRef: "00000000-0000-7000-8000-000000000206",
    operationReceiptRef: "00000000-0000-7000-8000-000000000207",
    outboxEventRef: "00000000-0000-7000-8000-000000000208",
    allocations: [
      { creditGrantId: "00000000-0000-7000-8000-000000000101", amount: 40n, ordinal: 0 },
      { creditGrantId: "00000000-0000-7000-8000-000000000102", amount: 20n, ordinal: 1 },
    ],
  };
}

function operation(operationKind: "finalize_segment" | "release_segment" | "reconcile_segment") {
  return { siteId: "site-1", operationKind, businessOperationKey: `${operationKind}:segment-1`,
    requestDigest: "b".repeat(64) };
}

function storedSegment(state: "committed" | "released" | "reconciliation_required"): StoredSegmentAllocation {
  const committed = state !== "released";
  return {
    siteId: "site-1", billingAccountId: "billing-1",
    creditAccountId: "00000000-0000-7000-8000-000000000001", unit: "credit_micros",
    liabilityMerchantAccountId: "merchant-1", ratingPolicyRevisionRef: "rating-1",
    executionBudgetRootRef: "00000000-0000-7000-8000-000000000202",
    executionBudgetRootState: "open", executionBudgetRootVersion: 1n,
    creditHoldRef: "00000000-0000-7000-8000-000000000201",
    creditHoldState: "open", creditHoldFenceEpoch: 1n,
    budgetAllocationRef: "00000000-0000-7000-8000-000000000203",
    authorizationSegmentRef: "00000000-0000-7000-8000-000000000205",
    executionManifestRef: "manifest-1",
    allocation: { revision: committed ? 2n : 1n, allocationEpoch: 1n, creditCeiling: 60n,
      unassignedStock: committed ? 35n : 60n, activeChildReservedStock: 0n,
      committedStock: committed ? 25n : 0n, capturedCumulative: 0n,
      returnedToParentCumulative: 0n, state: "active" },
    segment: { state, maximumAmount: 25n, allocationEpoch: 1n,
      preparedAgainstAllocationRevision: 1n, committedFromAllocationRevision: committed ? 1n : null,
      committedToAllocationRevision: committed ? 2n : null,
      aggregateVersion: state === "reconciliation_required" ? 3n : 2n,
      fenceEpoch: state === "reconciliation_required" ? 3n : 2n,
      resolutionKind: state === "released" ? "not_dispatched" : state === "reconciliation_required" ? "outcome_unknown" : null,
      resolutionRef: state === "released" ? "no-dispatch-1" : state === "reconciliation_required" ? "unknown-1" : null,
      committedAt: committed ? NOW : null, settledAt: null, releasedAt: state === "released" ? NOW : null },
  };
}
