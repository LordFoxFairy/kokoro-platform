import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  MediaChildAllocationReservationRecord,
  MediaChildAllocationReturnRecord,
  RootBudgetReservationRecord,
  StoredMediaChildAllocation,
  StoredParentAllocation,
  StoredSegmentAllocation,
} from
  "../../src/modules/credit/application/contracts/credit-authority-repository.js";
import { PostgresCreditAuthorityRepository } from
  "../../src/modules/credit/infrastructure/postgres/credit-authority-repository.js";
import {
  buildDerivedMediaChildReceipt,
  buildReturnedMediaChildReceipt,
} from "../../src/modules/credit/application/media-child-receipt-codec.js";
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
      expect(sql.reads[0]?.statement).toContain("pg_advisory_xact_lock");
      expect(sql.reads[1]?.statement).toContain("platform.credit_budget_operation_receipt");
      expect(sql.reads[1]?.statement).not.toMatch(
        /FOR\s+(?:NO\s+KEY\s+)?UPDATE|FOR\s+(?:KEY\s+)?SHARE/iu,
      );
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
      expect(sql.writeSql()).toContain("surface_ref,capability_key,agent_ref");
      expect(sql.writeSql()).toContain("INSERT INTO platform.credit_authorization_segment");
      expect(sql.writeSql()).toContain("INSERT INTO platform.outbox_event");
      expect(sql.writeSql()).toContain("INSERT INTO platform.credit_budget_operation_receipt");
      expect(sql.indexOf("platform.outbox_event")).toBeLessThan(sql.indexOf("platform.credit_budget_operation_receipt"));

      const journal = sql.writes.find((write) => write.statement.includes("credit_journal_transaction"));
      const expectedEntries = [
        [0, "site-1", "00000000-0000-7000-8000-000000000001", "credit_micros", "debit", "customer_available", 40, "00000000-0000-7000-8000-000000000101", "00000000-0000-7000-8000-000000000201"],
        [1, "site-1", "00000000-0000-7000-8000-000000000001", "credit_micros", "credit", "customer_reserved", 40, "00000000-0000-7000-8000-000000000101", "00000000-0000-7000-8000-000000000201"],
        [2, "site-1", "00000000-0000-7000-8000-000000000001", "credit_micros", "debit", "customer_available", 20, "00000000-0000-7000-8000-000000000102", "00000000-0000-7000-8000-000000000201"],
        [3, "site-1", "00000000-0000-7000-8000-000000000001", "credit_micros", "credit", "customer_reserved", 20, "00000000-0000-7000-8000-000000000102", "00000000-0000-7000-8000-000000000201"],
      ];
      expect(journal?.values?.[7]).toBe(databaseJournalDigest(expectedEntries));
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("serializes the CreditAccount identity before taking a SELECT-only grant-balance snapshot", async () => {
    const sql = new RecordingSql();
    sql.accountRows = [{ creditAccountId: "00000000-0000-7000-8000-000000000001",
      state: "active", aggregateVersion: 1n }];
    sql.grantRows = [{ creditGrantId: "00000000-0000-7000-8000-000000000101",
      availableAmount: "60", bucketClass: "permanent", expiresAt: null,
      burnPriority: 10, acquiredAt: NOW }];
    const lease = issuePlatformTransaction(sql);
    try {
      const result = await postgresRepository().lockGrantAvailability(lease.transaction, {
        siteId: "site-1", billingAccountId: "billing-1",
        creditAccountId: "00000000-0000-7000-8000-000000000001", unit: "credit_micros",
        liabilityMerchantAccountId: "merchant-1", effectiveAt: NOW,
        consumptionScope: { surfaceRef: "general.chat", capabilityKey: "general.chat.message", agentRef: null },
      });
      expect(result).toMatchObject([{ availableAmount: 60n }]);
      expect(sql.readSql()).toMatch(
        /pg_advisory_xact_lock[\s\S]+FROM platform.credit_account[\s\S]+FROM platform.credit_grant[\s\S]+available_amount/u,
      );
      expect(sql.reads[1]?.statement).not.toMatch(
        /FOR\s+(?:NO\s+KEY\s+)?UPDATE|FOR\s+(?:KEY\s+)?SHARE/iu,
      );
      expect(sql.reads[2]?.statement).not.toMatch(
        /FOR\s+(?:NO\s+KEY\s+)?UPDATE|FOR\s+(?:KEY\s+)?SHARE/iu,
      );
      expect(sql.readSql()).toContain("platform.valid_credit_scope_policy(grant_fact.scope_policy)");
      expect(sql.readSql()).toContain("grant_fact.scope_policy->'surfaceRefs' ? $5");
      expect(sql.readSql()).toContain("grant_fact.scope_policy->'capabilityKeys' ? $6");
      expect(sql.reads.at(-1)?.values).toEqual([
        "site-1", "00000000-0000-7000-8000-000000000001", "credit_micros", NOW,
        "general.chat", "general.chat.message", null,
      ]);
      expect(sql.reads[0]?.values).toEqual(["credit-account|site-1|billing-1|credit_micros|merchant-1"]);
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

  it("uses the global allocation-root-hold order before locking and fresh-loading a settlement segment", async () => {
    const sql = new RecordingSql();
    sql.segmentRows = [segmentRow()];
    const lease = issuePlatformTransaction(sql);
    try {
      await expect(postgresRepository().lockSegmentAllocation(lease.transaction, {
        siteId: "site-1",
        authorizationSegmentRef: "00000000-0000-7000-8000-000000000205",
      })).resolves.toMatchObject({
        budgetAllocationRef: "00000000-0000-7000-8000-000000000203",
        allocation: { revision: 1n },
        segment: { aggregateVersion: 1n },
      });
      expect(sql.reads.map((read) => read.statement.match(/\/\* ([^*]+) \*\//u)?.[1])).toEqual([
        undefined,
        "credit-segment-lineage-read",
        "credit-financial-allocation-lock",
        "credit-financial-root-lock",
        "credit-financial-hold-lock",
        "credit-segment-fresh-load",
      ]);
      expect(sql.reads[0]?.statement).toContain("pg_advisory_xact_lock");
      expect(sql.reads[0]?.values).toEqual([
        "credit-segment|site-1|00000000-0000-7000-8000-000000000205",
      ]);
      expect(sql.reads[2]?.statement).not.toMatch(
        /FOR\s+(?:NO\s+KEY\s+)?UPDATE|FOR\s+(?:KEY\s+)?SHARE/iu,
      );
      expect(sql.reads.at(-1)?.statement).toContain("FOR UPDATE OF segment");
      expect(sql.reads.at(-1)?.statement).not.toContain("FOR UPDATE OF segment,allocation,root,hold");
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("serializes a producer Segment read without requiring row-lock privileges", async () => {
    const sql = new RecordingSql();
    sql.segmentRows = [segmentRow()];
    const lease = issuePlatformTransaction(sql);
    try {
      await expect(postgresRepository().loadSegmentAllocationForUsageProducer(lease.transaction, {
        siteId: "site-1",
        authorizationSegmentRef: "00000000-0000-7000-8000-000000000205",
      })).resolves.toMatchObject({
        budgetAllocationRef: "00000000-0000-7000-8000-000000000203",
        segment: { aggregateVersion: 1n },
      });
      expect(sql.reads).toHaveLength(2);
      expect(sql.reads[0]?.statement).toContain("pg_advisory_xact_lock");
      expect(sql.reads[0]?.values).toEqual([
        "credit-segment|site-1|00000000-0000-7000-8000-000000000205",
      ]);
      expect(sql.reads[1]?.statement).toContain("credit-segment-fresh-load");
      expect(sql.reads[1]?.statement).not.toMatch(
        /FOR\s+(?:NO\s+KEY\s+)?UPDATE|FOR\s+(?:KEY\s+)?SHARE/iu,
      );
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("locks the exact Site/root/parent lineage and rejects corrupt persisted allocation revisions", async () => {
    const sql = new RecordingSql();
    sql.parentRows = [parentRow()];
    const lease = issuePlatformTransaction(sql);
    try {
      const repository = postgresRepository();
      await expect(repository.lockParentAllocation(lease.transaction, {
        siteId: "site-1",
        executionBudgetRootRef: "00000000-0000-7000-8000-000000000202",
        parentAllocationRef: "00000000-0000-7000-8000-000000000203",
      })).resolves.toMatchObject({
        parentAllocationRef: "00000000-0000-7000-8000-000000000203",
        allocation: { revision: 3n, unassignedStock: 100n },
      });
      const [allocationLock, rootLock, holdLock, freshLoad] = sql.reads;
      expect(allocationLock?.statement).toContain("credit-financial-allocation-lock");
      expect(allocationLock?.statement).not.toMatch(
        /FOR\s+(?:NO\s+KEY\s+)?UPDATE|FOR\s+(?:KEY\s+)?SHARE/iu,
      );
      expect(allocationLock?.statement).toContain("ORDER BY allocation.budget_allocation_ref");
      expect(allocationLock?.statement).not.toMatch(/\bJOIN\b|current_revision|credit_budget_allocation_revision|receipt/iu);
      expect(rootLock?.statement).toContain("credit-financial-root-lock");
      expect(rootLock?.statement).toContain("FOR UPDATE OF root");
      expect(holdLock?.statement).toContain("credit-financial-hold-lock");
      expect(holdLock?.statement).toContain("FOR UPDATE OF hold");
      expect(freshLoad?.statement).toContain("credit-parent-allocation-fresh-load");
      expect(freshLoad?.statement).toContain("revision.revision=allocation.current_revision");
      expect(freshLoad?.statement).not.toContain("FOR UPDATE");
      expect(allocationLock?.values).toEqual([
        "site-1",
        "00000000-0000-7000-8000-000000000202",
        ["00000000-0000-7000-8000-000000000203"],
      ]);
      expect(freshLoad?.values).toEqual([
        "site-1",
        "00000000-0000-7000-8000-000000000202",
        "00000000-0000-7000-8000-000000000203",
      ]);

      sql.parentRows = [{ ...parentRow(), revision: "4", unassignedStock: "70",
        activeChildReservedStock: "30" }];
      await expect(repository.lockParentAllocation(lease.transaction, {
        siteId: "site-1",
        executionBudgetRootRef: "00000000-0000-7000-8000-000000000202",
        parentAllocationRef: "00000000-0000-7000-8000-000000000203",
      })).resolves.toMatchObject({ allocation: { revision: 4n, unassignedStock: 70n } });

      sql.parentRows = [{ ...parentRow(), unassignedStock: "99" }];
      await expect(repository.lockParentAllocation(lease.transaction, {
        siteId: "site-1",
        executionBudgetRootRef: "00000000-0000-7000-8000-000000000202",
        parentAllocationRef: "00000000-0000-7000-8000-000000000203",
      })).rejects.toThrow("CREDIT_ALLOCATION_CONSERVATION_VIOLATION");
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("atomically writes parent/child revisions, reservation receipt, and exact operation receipt", async () => {
    const sql = new RecordingSql();
    sql.queryResults.push([]);
    const lease = issuePlatformTransaction(sql);
    try {
      const result = await postgresRepository().createMediaChildAllocation(
        lease.transaction,
        childReservationRecord(),
      );
      expect(result).toMatchObject({ kind: "accepted", value: { state: "active" } });
      expect(sql.writeSql()).toMatch(
        /credit_budget_allocation_revision[\s\S]+credit_budget_allocation[\s\S]+credit_budget_allocation_revision[\s\S]+credit_allocation_reservation_receipt[\s\S]+credit_budget_operation_receipt/u,
      );
      expect(sql.writeSql()).not.toContain("INSERT INTO platform.outbox_event");
      expect(sql.writeSql()).toContain("'media'");
      expect(sql.writeSql()).toContain("parent_before_revision,parent_after_revision");
      expect(sql.writeSql()).toContain("child_before_revision,child_after_revision");
      expect(sql.writeSql()).toContain("credit_amount");
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("locks parent and Media child together and atomically writes terminal return authority", async () => {
    const sql = new RecordingSql();
    sql.childRows = [childRow()];
    const lease = issuePlatformTransaction(sql);
    try {
      const repository = postgresRepository();
      await expect(repository.lockMediaChildAllocation(lease.transaction, {
        siteId: "site-1",
        executionBudgetRootRef: "00000000-0000-7000-8000-000000000202",
        parentAllocationRef: "00000000-0000-7000-8000-000000000203",
        childAllocationRef: "00000000-0000-7000-8000-000000000301",
      })).resolves.toMatchObject({
        parentAllocation: { revision: 4n },
        childAllocation: { revision: 2n, capturedCumulative: 10n },
      });
      const [allocationLock, rootLock, holdLock, freshLoad] = sql.reads;
      expect(allocationLock?.statement).toContain("credit-financial-allocation-lock");
      expect(allocationLock?.statement).toContain("ORDER BY allocation.budget_allocation_ref");
      expect(allocationLock?.statement).not.toMatch(
        /FOR\s+(?:NO\s+KEY\s+)?UPDATE|FOR\s+(?:KEY\s+)?SHARE/iu,
      );
      expect(allocationLock?.statement).not.toMatch(/\bJOIN\b|current_revision|credit_budget_allocation_revision|receipt/iu);
      expect(rootLock?.statement).toContain("credit-financial-root-lock");
      expect(holdLock?.statement).toContain("credit-financial-hold-lock");
      expect(freshLoad?.statement).toContain("credit-media-child-allocation-fresh-load");
      expect(freshLoad?.statement).toContain("prior_return.result AS \"priorReturnResult\"");
      expect(freshLoad?.statement).not.toContain("FOR UPDATE");
      expect(allocationLock?.values).toEqual([
        "site-1",
        "00000000-0000-7000-8000-000000000202",
        ["00000000-0000-7000-8000-000000000203", "00000000-0000-7000-8000-000000000301"],
      ]);

      sql.queryResults.push([]);
      const result = await repository.closeMediaChildAllocation(
        lease.transaction,
        childReturnRecord(),
      );
      expect(result).toMatchObject({ kind: "accepted", value: { state: "terminal" } });
      expect(sql.writeSql()).toMatch(
        /credit_budget_allocation_revision[\s\S]+credit_budget_allocation_revision[\s\S]+credit_allocation_return_receipt[\s\S]+credit_budget_operation_receipt/u,
      );
      expect(sql.writeSql()).not.toContain("INSERT INTO platform.outbox_event");
      expect(sql.writeSql()).toContain("owner_closure_evidence_ref");
      expect(sql.writeSql()).toContain("captured_amount");
      expect(sql.writeSql()).toContain("owner_closure_outcome");
      expect(sql.writeSql()).toContain("root_state_at_return");
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("strictly rehydrates child operation receipts and rejects extra persisted result keys", async () => {
    const sql = new RecordingSql();
    sql.queryResults.push([childOperationReceiptRow()]);
    const lease = issuePlatformTransaction(sql);
    try {
      const repository = postgresRepository();
      const identity = { siteId: "site-1", operationKind: "derive_media_child" as const,
        businessOperationKey: "derive:media-operation-1", requestDigest: "b".repeat(64) };
      await expect(repository.findOperationReceipt(lease.transaction, identity)).resolves.toMatchObject({
        kind: "replayed", value: { state: "active", reservedCeiling: 30n },
      });

      const corrupt = childOperationReceiptRow({ invented: true });
      sql.queryResults.push([corrupt]);
      await expect(repository.findOperationReceipt(lease.transaction, identity))
        .rejects.toThrow("CREDIT_OPERATION_RECEIPT_CORRUPT");
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("fails closed when a terminal child's prior return receipt digest or stored scope is tampered", async () => {
    const sql = new RecordingSql();
    const lease = issuePlatformTransaction(sql);
    try {
      const repository = postgresRepository();
      sql.childRows = [terminalChildRow({ priorReturnResultDigest: "0".repeat(64) })];
      await expect(repository.lockMediaChildAllocation(lease.transaction, {
        siteId: "site-1",
        executionBudgetRootRef: "00000000-0000-7000-8000-000000000202",
        parentAllocationRef: "00000000-0000-7000-8000-000000000203",
        childAllocationRef: "00000000-0000-7000-8000-000000000301",
      })).rejects.toThrow("CREDIT_MEDIA_CHILD_RETURN_RECEIPT_DIGEST_MISMATCH");

      sql.childRows = [terminalChildRow({
        priorReturnChildAllocationRef: "00000000-0000-7000-8000-000000000399",
      })];
      await expect(repository.lockMediaChildAllocation(lease.transaction, {
        siteId: "site-1",
        executionBudgetRootRef: "00000000-0000-7000-8000-000000000202",
        parentAllocationRef: "00000000-0000-7000-8000-000000000203",
        childAllocationRef: "00000000-0000-7000-8000-000000000301",
      })).rejects.toThrow("CREDIT_MEDIA_CHILD_RETURN_RECEIPT_SCOPE_MISMATCH");

      sql.childRows = [terminalChildRow({}, {
        reason: "canceled_before_effect",
        ownerClosureEvidence: { ...returnedReceipt().ownerClosureEvidence, outcome: "partial" },
      })];
      await expect(repository.lockMediaChildAllocation(lease.transaction, {
        siteId: "site-1",
        executionBudgetRootRef: "00000000-0000-7000-8000-000000000202",
        parentAllocationRef: "00000000-0000-7000-8000-000000000203",
        childAllocationRef: "00000000-0000-7000-8000-000000000301",
      })).rejects.toThrow("CREDIT_OPERATION_RECEIPT_CORRUPT");
      expect(sql.readSql()).toContain("receipt.result_digest AS \"priorReturnResultDigest\"");
      expect(sql.readSql()).toContain("receipt.operation_kind AS \"priorReturnOperationKind\"");
      expect(sql.readSql()).toContain("receipt.request_digest AS \"priorReturnRequestDigest\"");
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("fresh-loads a winner's terminal head and return receipt after waiting for ordered base locks", async () => {
    const sql = new RecordingSql();
    sql.childRows = [terminalChildRow()];
    const lease = issuePlatformTransaction(sql);
    try {
      await expect(postgresRepository().lockMediaChildAllocation(lease.transaction, {
        siteId: "site-1",
        executionBudgetRootRef: "00000000-0000-7000-8000-000000000202",
        parentAllocationRef: "00000000-0000-7000-8000-000000000203",
        childAllocationRef: "00000000-0000-7000-8000-000000000301",
      })).resolves.toMatchObject({
        parentAllocation: { revision: 5n },
        childAllocation: { revision: 3n, allocationEpoch: 2n, state: "terminal" },
        priorReturn: {
          operation: { operationKind: "return_media_child", businessOperationKey: "return:media-operation-1" },
          value: { state: "terminal", childRevisionAfter: 3n },
        },
      });
      expect(sql.reads[0]?.statement).toContain("credit-financial-allocation-lock");
      expect(sql.reads[1]?.statement).toContain("credit-financial-root-lock");
      expect(sql.reads[2]?.statement).toContain("credit-financial-hold-lock");
      expect(sql.reads[3]?.statement).toContain("credit-media-child-allocation-fresh-load");
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
  parentRows: readonly Record<string, unknown>[] = [];
  childRows: readonly Record<string, unknown>[] = [];
  segmentRows: readonly Record<string, unknown>[] = [];
  parentLockRows: readonly Record<string, unknown>[] = [{
    allocationRef: "00000000-0000-7000-8000-000000000203",
  }];
  childLockRows: readonly Record<string, unknown>[] = [
    { allocationRef: "00000000-0000-7000-8000-000000000203" },
    { allocationRef: "00000000-0000-7000-8000-000000000301" },
  ];
  zeroChangeFragment: string | null = null;

  async query<Row extends Record<string, unknown>>(statement: string, values?: readonly unknown[]): Promise<readonly Row[]> {
    this.reads.push(values === undefined ? { statement } : { statement, values });
    if (statement.includes("credit-financial-allocation-lock")) {
      const refs = values?.[2];
      return (Array.isArray(refs) && refs.length === 2 ? this.childLockRows : this.parentLockRows) as readonly Row[];
    }
    if (statement.includes("credit-financial-root-lock")) return [{
      creditHoldRef: "00000000-0000-7000-8000-000000000201",
    }] as unknown as readonly Row[];
    if (statement.includes("credit-financial-hold-lock")) return [{
      creditHoldRef: "00000000-0000-7000-8000-000000000201",
    }] as unknown as readonly Row[];
    if (statement.includes("credit-segment-lineage-read")) return [{
      executionBudgetRootRef: "00000000-0000-7000-8000-000000000202",
      budgetAllocationRef: "00000000-0000-7000-8000-000000000203",
      creditHoldRef: "00000000-0000-7000-8000-000000000201",
    }] as unknown as readonly Row[];
    if (statement.includes("credit-segment-fresh-load")) return this.segmentRows as readonly Row[];
    if (statement.includes("credit-parent-allocation-fresh-load")) return this.parentRows as readonly Row[];
    if (statement.includes("credit-media-child-allocation-fresh-load")) return this.childRows as readonly Row[];
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

function databaseJournalDigest(entries: readonly (readonly (string | number)[])[]): string {
  const canonical = entries.flatMap((entry) => entry.map((field) => {
    const value = String(field);
    return `${Buffer.byteLength(value, "utf8")}:${value}`;
  })).join("");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function receiptRow(requestDigest: string) {
  const result = {
    executionBudgetRootRef: "00000000-0000-7000-8000-000000000202",
    creditHoldRef: "00000000-0000-7000-8000-000000000201",
    rootAllocationRef: "00000000-0000-7000-8000-000000000203",
    rootAllocationRevision: "1",
    rootAllocationEpoch: "1",
    authorizationSegmentRef: "00000000-0000-7000-8000-000000000205",
    segmentVersion: "1", state: "reserved", expiresAt: "2026-07-29T00:05:00.000Z",
  };
  return { requestDigest, outcomeKind: "accepted", result,
    resultDigest: createHash("sha256").update(canonical(result)).digest("hex"),
    executionBudgetRootRef: result.executionBudgetRootRef,
    authorizationSegmentRef: result.authorizationSegmentRef,
    parentAllocationRef: null, childAllocationRef: null,
    parentBeforeRevision: null, parentAfterRevision: null,
    childBeforeRevision: null, childAfterRevision: null,
    creditAmount: null, ownerClosureEvidenceRef: null };
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
    consumptionScope: { surfaceRef: "general.chat", capabilityKey: "general.chat.message", agentRef: null },
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
    executionManifestRef: "manifest-1", expiresAt: "2026-07-29T00:05:00.000Z",
    consumptionScope: { surfaceRef: "general.chat", capabilityKey: "general.chat.message", agentRef: null },
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

function segmentRow(): Record<string, unknown> {
  return {
    siteId: "site-1", billingAccountId: "billing-1",
    creditAccountId: "00000000-0000-7000-8000-000000000001", unit: "credit_micros",
    liabilityMerchantAccountId: "merchant-1", ratingPolicyRevisionRef: "rating-1",
    executionBudgetRootRef: "00000000-0000-7000-8000-000000000202",
    executionBudgetRootState: "open", executionBudgetRootVersion: "1",
    creditHoldRef: "00000000-0000-7000-8000-000000000201",
    creditHoldState: "open", creditHoldFenceEpoch: "1",
    budgetAllocationRef: "00000000-0000-7000-8000-000000000203",
    authorizationSegmentRef: "00000000-0000-7000-8000-000000000205",
    executionManifestRef: "manifest-1", surfaceRef: "general.chat",
    capabilityKey: "general.chat.message", agentRef: null,
    expiresAt: "2026-07-29T00:05:00.000Z", revision: "1", allocationEpoch: "1",
    creditCeiling: "60", unassignedStock: "60", activeChildReservedStock: "0",
    committedStock: "0", capturedCumulative: "0", returnedToParentCumulative: "0",
    allocationState: "active", segmentState: "reserved", maximumAmount: "25",
    segmentAllocationEpoch: "1", preparedAgainstAllocationRevision: "1",
    committedFromAllocationRevision: null, committedToAllocationRevision: null,
    aggregateVersion: "1", fenceEpoch: "1", resolutionKind: null, resolutionRef: null,
    committedAt: null, settledAt: null, releasedAt: null,
  };
}

function storedParentAllocation(): StoredParentAllocation {
  return {
    siteId: "site-1", billingAccountId: "billing-1",
    creditAccountId: "00000000-0000-7000-8000-000000000001", unit: "credit_micros",
    liabilityMerchantAccountId: "merchant-1",
    executionBudgetRootRef: "00000000-0000-7000-8000-000000000202",
    executionBudgetRootState: "open", creditHoldRef: "00000000-0000-7000-8000-000000000201",
    creditHoldState: "open", creditHoldExpiresAt: "2026-07-29T00:05:00.000Z",
    ratingPolicyRevisionRef: "rating-1",
    parentAllocationRef: "00000000-0000-7000-8000-000000000203",
    isRoot: true, audience: "root", reservedSegmentStock: 0n,
    allocation: { revision: 3n, allocationEpoch: 2n, creditCeiling: 100n,
      unassignedStock: 100n, activeChildReservedStock: 0n, committedStock: 0n,
      capturedCumulative: 0n, returnedToParentCumulative: 0n, state: "active" },
  };
}

function childReservationRecord(): MediaChildAllocationReservationRecord {
  const parent = storedParentAllocation();
  const receipt = derivedReceipt();
  return {
    operation: { siteId: "site-1", operationKind: "derive_media_child",
      businessOperationKey: "derive:media-operation-1", requestDigest: "b".repeat(64) },
    parent,
    parentAllocation: { ...parent.allocation, revision: 4n, unassignedStock: 70n,
      activeChildReservedStock: 30n },
    childAllocation: { revision: 1n, allocationEpoch: 1n, creditCeiling: 30n,
      unassignedStock: 30n, activeChildReservedStock: 0n, committedStock: 0n,
      capturedCumulative: 0n, returnedToParentCumulative: 0n, state: "active",
      terminalReceiptDigest: null, parentAppliedRevision: null },
    childAllocationRevisionRef: "00000000-0000-7000-8000-000000000302",
    parentAllocationRevisionRef: "00000000-0000-7000-8000-000000000303",
    operationReceiptRef: "00000000-0000-7000-8000-000000000304",
    receipt,
    siteId: "site-1",
    executionBudgetRootRef: parent.executionBudgetRootRef,
    parentAllocationRef: parent.parentAllocationRef,
    childAllocationRef: receipt.childAllocationRef,
    childAuthorizationSegmentRef: receipt.childAuthorizationSegmentRef,
    executionManifestRef: "manifest-1",
    mediaOperationRef: receipt.mediaOperationRef,
    audience: "media",
    purpose: "media_operation",
    consumptionScope: receipt.consumptionScope,
    expiresAt: receipt.expiresAt,
    occurredAt: NOW,
  };
}

function storedMediaChildAllocation(): StoredMediaChildAllocation {
  return {
    siteId: "site-1", billingAccountId: "billing-1",
    creditAccountId: "00000000-0000-7000-8000-000000000001", unit: "credit_micros",
    liabilityMerchantAccountId: "merchant-1",
    executionBudgetRootRef: "00000000-0000-7000-8000-000000000202",
    executionBudgetRootState: "open", creditHoldRef: "00000000-0000-7000-8000-000000000201",
    creditHoldState: "open", creditHoldExpiresAt: "2026-07-29T00:05:00.000Z",
    parentAllocationRef: "00000000-0000-7000-8000-000000000203",
    parentAllocation: { revision: 4n, allocationEpoch: 2n, creditCeiling: 100n,
      unassignedStock: 70n, activeChildReservedStock: 30n, committedStock: 0n,
      capturedCumulative: 0n, returnedToParentCumulative: 0n, state: "active" },
    childAllocationRef: "00000000-0000-7000-8000-000000000301",
    childAuthorizationSegmentRef: "00000000-0000-7000-8000-000000000305",
    executionManifestRef: "manifest-1",
    childAudience: "media", childPurpose: "media_operation", mediaOperationRef: "media-operation-1",
    consumptionScope: { surfaceRef: "media.image", capabilityKey: "image.text_to_image", agentRef: null },
    expiresAt: "2026-07-29T00:04:00.000Z",
    childAllocation: { revision: 2n, allocationEpoch: 1n, creditCeiling: 30n,
      unassignedStock: 20n, activeChildReservedStock: 0n, committedStock: 0n,
      capturedCumulative: 10n, returnedToParentCumulative: 0n, state: "active",
      terminalReceiptDigest: null, parentAppliedRevision: null },
    authorizationClosure: { reserved: 0n, committed: 0n, ratingPending: 0n,
      reconciliationRequired: 0n },
    priorReturn: null,
  };
}

function childReturnRecord(): MediaChildAllocationReturnRecord {
  const current = storedMediaChildAllocation();
  const receipt = returnedReceipt();
  return {
    operation: { siteId: "site-1", operationKind: "return_media_child",
      businessOperationKey: "return:media-operation-1", requestDigest: "d".repeat(64) },
    current,
    parentAllocation: { ...current.parentAllocation, revision: 5n, unassignedStock: 90n,
      activeChildReservedStock: 0n, capturedCumulative: 10n },
    childAllocation: { ...current.childAllocation, revision: 3n, allocationEpoch: 2n,
      unassignedStock: 0n, returnedToParentCumulative: 20n, state: "terminal",
      terminalReceiptDigest: receipt.receiptDigest, parentAppliedRevision: 5n },
    childAllocationRevisionRef: "00000000-0000-7000-8000-000000000306",
    parentAllocationRevisionRef: "00000000-0000-7000-8000-000000000307",
    operationReceiptRef: "00000000-0000-7000-8000-000000000308",
    receipt,
    occurredAt: NOW,
  };
}

function derivedReceipt() {
  return buildDerivedMediaChildReceipt({
    allocationReservationReceiptRef: "00000000-0000-7000-8000-000000000310",
    executionBudgetRootRef: "00000000-0000-7000-8000-000000000202",
    parentAllocationRef: "00000000-0000-7000-8000-000000000203",
    parentRevisionBefore: 3n, parentRevisionAfter: 4n, parentAllocationEpoch: 2n,
    childAllocationRef: "00000000-0000-7000-8000-000000000301",
    childAuthorizationSegmentRef: "00000000-0000-7000-8000-000000000305",
    childAuthorizationSegmentVersion: 1n,
    childRevisionBefore: 0n as const, childRevisionAfter: 1n as const, childAllocationEpoch: 1n as const,
    mediaOperationRef: "media-operation-1", reservedCeiling: 30n,
    audience: "media" as const, purpose: "media_operation" as const,
    consumptionScope: { surfaceRef: "media.image", capabilityKey: "image.text_to_image", agentRef: null },
    expiresAt: "2026-07-29T00:04:00.000Z", state: "active" as const, observedAt: NOW,
  }, { siteId: "site-1", operationKind: "derive_media_child",
    businessOperationKey: "derive:media-operation-1", requestDigest: "b".repeat(64) });
}

function returnedReceipt() {
  return buildReturnedMediaChildReceipt({
    allocationReturnReceiptRef: "00000000-0000-7000-8000-000000000311",
    executionBudgetRootRef: "00000000-0000-7000-8000-000000000202",
    parentAllocationRef: "00000000-0000-7000-8000-000000000203",
    childAllocationRef: "00000000-0000-7000-8000-000000000301",
    parentRevisionBefore: 4n, parentRevisionAfter: 5n, parentAllocationEpoch: 2n,
    childRevisionBefore: 2n, childRevisionAfter: 3n,
    childAllocationEpochBefore: 1n, childAllocationEpochAfter: 2n,
    mediaOperationRef: "media-operation-1", returnedAmount: 20n, capturedAmount: 10n,
    reason: "completed" as const, rootStateAtReturn: "open" as const,
    ownerClosureEvidence: { kind: "media_operation_terminal" as const,
      mediaOperationRef: "media-operation-1", terminalReceiptRef: "terminal-receipt-1",
      outcome: "completed" as const },
    state: "terminal" as const, observedAt: NOW,
  }, { siteId: "site-1", operationKind: "return_media_child",
    businessOperationKey: "return:media-operation-1", requestDigest: "d".repeat(64) });
}

function parentRow() {
  return {
    siteId: "site-1", billingAccountId: "billing-1",
    creditAccountId: "00000000-0000-7000-8000-000000000001", unit: "credit_micros",
    liabilityMerchantAccountId: "merchant-1",
    executionBudgetRootRef: "00000000-0000-7000-8000-000000000202",
    executionBudgetRootState: "open", creditHoldRef: "00000000-0000-7000-8000-000000000201",
    creditHoldState: "open", creditHoldExpiresAt: NOW,
    ratingPolicyRevisionRef: "rating-1",
    parentAllocationRef: "00000000-0000-7000-8000-000000000203",
    isRoot: true, audience: "root", reservedSegmentStock: "0",
    revision: "3", allocationEpoch: "2", creditCeiling: "100", unassignedStock: "100",
    activeChildReservedStock: "0", committedStock: "0", capturedCumulative: "0",
    returnedToParentCumulative: "0", allocationState: "active",
  };
}

function childRow() {
  return {
    ...parentRow(),
    parentRevision: "4", parentAllocationEpoch: "2", parentCreditCeiling: "100",
    parentUnassignedStock: "70", parentActiveChildReservedStock: "30",
    parentCommittedStock: "0", parentCapturedCumulative: "0",
    parentReturnedToParentCumulative: "0", parentAllocationState: "active",
    childAllocationRef: "00000000-0000-7000-8000-000000000301",
    childAuthorizationSegmentRef: "00000000-0000-7000-8000-000000000305",
    executionManifestRef: "manifest-1",
    childAudience: "media", childPurpose: "media_operation", mediaOperationRef: "media-operation-1",
    surfaceRef: "media.image", capabilityKey: "image.text_to_image", agentRef: null,
    expiresAt: "2026-07-29T00:04:00.000Z",
    childRevision: "2", childAllocationEpoch: "1", childCreditCeiling: "30",
    childUnassignedStock: "20", childActiveChildReservedStock: "0", childCommittedStock: "0",
    childCapturedCumulative: "10", childReturnedToParentCumulative: "0", childAllocationState: "active",
    terminalReceiptDigest: null, parentAppliedRevision: null,
    reservedAuthorizationCount: "0", committedAuthorizationCount: "0", ratingPendingCount: "0",
    reconciliationRequiredCount: "0", priorReturnResult: null,
    priorReturnResultDigest: null, priorReturnOperationKind: null,
    priorReturnBusinessOperationKey: null, priorReturnRequestDigest: null,
    priorReturnExecutionBudgetRootRef: null, priorReturnAuthorizationSegmentRef: null,
    priorReturnParentAllocationRef: null, priorReturnChildAllocationRef: null,
    priorReturnParentBeforeRevision: null, priorReturnParentAfterRevision: null,
    priorReturnChildBeforeRevision: null, priorReturnChildAfterRevision: null,
    priorReturnCreditAmount: null, priorReturnOwnerClosureEvidenceRef: null,
  };
}

function terminalChildRow(
  overrides: Readonly<Record<string, unknown>> = {},
  resultOverrides: Readonly<Record<string, unknown>> = {},
) {
  const result = { ...returnedReceipt(), parentRevisionBefore: "4", parentRevisionAfter: "5",
    parentAllocationEpoch: "2", childRevisionBefore: "2", childRevisionAfter: "3",
    childAllocationEpochBefore: "1", childAllocationEpochAfter: "2", returnedAmount: "20",
    capturedAmount: "10", ...resultOverrides };
  return {
    ...childRow(),
    parentRevision: "5", parentUnassignedStock: "90", parentActiveChildReservedStock: "0",
    parentCapturedCumulative: "10",
    childRevision: "3", childAllocationEpoch: "2", childUnassignedStock: "0",
    childReturnedToParentCumulative: "20", childAllocationState: "terminal",
    terminalReceiptDigest: returnedReceipt().receiptDigest, parentAppliedRevision: "5",
    priorReturnResult: result,
    priorReturnResultDigest: createHash("sha256").update(canonical(result)).digest("hex"),
    priorReturnOperationKind: "return_media_child",
    priorReturnBusinessOperationKey: "return:media-operation-1",
    priorReturnRequestDigest: "d".repeat(64),
    priorReturnExecutionBudgetRootRef: result.executionBudgetRootRef,
    priorReturnAuthorizationSegmentRef: null,
    priorReturnParentAllocationRef: result.parentAllocationRef,
    priorReturnChildAllocationRef: result.childAllocationRef,
    priorReturnParentBeforeRevision: result.parentRevisionBefore,
    priorReturnParentAfterRevision: result.parentRevisionAfter,
    priorReturnChildBeforeRevision: result.childRevisionBefore,
    priorReturnChildAfterRevision: result.childRevisionAfter,
    priorReturnCreditAmount: result.returnedAmount,
    priorReturnOwnerClosureEvidenceRef: result.ownerClosureEvidence.terminalReceiptRef,
    ...overrides,
  };
}

function childOperationReceiptRow(extra: Readonly<Record<string, unknown>> = {}) {
  const result = { ...derivedReceipt(), parentRevisionBefore: "3", parentRevisionAfter: "4",
    parentAllocationEpoch: "2", childRevisionBefore: "0", childRevisionAfter: "1",
    childAllocationEpoch: "1", childAuthorizationSegmentVersion: "1",
    reservedCeiling: "30", ...extra };
  return { requestDigest: "b".repeat(64), outcomeKind: "accepted", result,
    resultDigest: createHash("sha256").update(canonical(result)).digest("hex"),
    executionBudgetRootRef: result.executionBudgetRootRef,
    authorizationSegmentRef: null,
    parentAllocationRef: result.parentAllocationRef,
    childAllocationRef: result.childAllocationRef,
    parentBeforeRevision: result.parentRevisionBefore,
    parentAfterRevision: result.parentRevisionAfter,
    childBeforeRevision: result.childRevisionBefore,
    childAfterRevision: result.childRevisionAfter,
    creditAmount: result.reservedCeiling,
    ownerClosureEvidenceRef: null };
}
