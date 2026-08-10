import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PostgresUsageSettlementRepository } from
  "../../src/modules/credit/infrastructure/postgres/usage-settlement-repository.js";
import { issuePlatformTransaction, revokePlatformTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";
import type { UsageReconciliationRecord, UsageSettlementRecord } from
  "../../src/modules/credit/application/contracts/usage-settlement-repository.js";

describe("PostgresUsageSettlementRepository", () => {
  it("owns an attempt before Provider I/O and advances unknown outcome with a fenced CAS", async () => {
    const sql = new RecordingSql();
    const lease = issuePlatformTransaction(sql);
    try {
      await repository().persistAttemptIntent(lease.transaction, attemptIntentRecord());
      await repository().updateAttemptIntent(lease.transaction, {
        ...attemptIntentRecord(), identity: { ...attemptIntentRecord().identity, operationKind: "attempt_unknown",
          businessOperationKey: "attempt:unknown:1", requestDigest: "2".repeat(64) },
        receipt: { ...attemptIntentRecord().receipt, state: "outcome_unknown", fenceEpoch: 2n },
        state: "outcome_unknown", fenceEpoch: 2n, ownerEvidenceRef: "provider-call:unknown",
        observedAt: NOW,
      });
      expect(sql.writeSql()).toMatch(/credit_usage_attempt_intent[\s\S]+credit_usage_command_receipt/u);
      expect(sql.writeSql()).toContain("fence_epoch=$1::bigint");
      expect(sql.writeSql()).toContain("fence_epoch=$8::bigint");
    } finally { revokePlatformTransaction(lease); }
  });

  it("persists canonical evidence and its authoritative receipt without an orphan outbox", async () => {
    const sql = new RecordingSql();
    const lease = issuePlatformTransaction(sql);
    try {
      await repository().persistAttemptUsage(lease.transaction, evidenceRecord());
      expect(sql.writeSql()).toMatch(/credit_attempt_usage_evidence[\s\S]+credit_usage_command_receipt/u);
      expect(sql.writeSql()).not.toContain("platform.outbox_event");
      expect(sql.writeSql()).not.toMatch(/UPDATE platform\.credit_attempt_usage_evidence|DELETE FROM/u);
    } finally { revokePlatformTransaction(lease); }
  });

  it("loads the latest producer evidence under the Segment advisory fence without a row lock", async () => {
    const sql = new RecordingSql();
    const lease = issuePlatformTransaction(sql);
    try {
      await repository().lockLatestAttemptEvidence(lease.transaction, {
        siteId: "site-1",
        authorizationSegmentRef: "00000000-0000-7000-8000-000000000205",
        producerKind: "model_gateway",
        producerContext: "gateway:one",
        producerGeneration: 1n,
        attemptRef: "attempt-1",
      });
      expect(sql.reads).toHaveLength(1);
      expect(sql.reads[0]?.statement).toContain("credit_attempt_usage_evidence");
      expect(sql.reads[0]?.statement).not.toMatch(
        /FOR\s+(?:NO\s+KEY\s+)?UPDATE|FOR\s+(?:KEY\s+)?SHARE/iu,
      );
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("settles a first closure through rating_pending, exact allocation capture and balanced source journal", async () => {
    const sql = new RecordingSql();
    const lease = issuePlatformTransaction(sql);
    try {
      await repository().persistSettlement(lease.transaction, settlementRecord());
      const statements = sql.writeSql();
      expect(statements).toMatch(/credit_rating_snapshot[\s\S]+credit_usage_segment_closure[\s\S]+credit_usage_closure_evidence/u);
      const segmentUpdates = sql.writes.filter((write) => write.statement.includes("UPDATE platform.credit_authorization_segment"));
      expect(segmentUpdates.map((write) => write.values?.[0])).toEqual(["rating_pending", "settled"]);
      expect(statements).toContain("credit_budget_allocation_revision");
      expect(statements).toMatch(/credit_journal_transaction[\s\S]+credit_journal_entry[\s\S]+credit_usage_settlement/u);
      expect(statements).toContain("credit_usage_settlement_source");
      expect(statements).toContain("credit_rated_usage");
      expect(sql.writes.filter((write) => write.statement.includes("credit_journal_entry"))).toHaveLength(2);
      const holdCapture = sql.writes.find((write) =>
        write.statement.includes("UPDATE platform.credit_hold") &&
        write.statement.includes("captured_amount=captured_amount"));
      expect(holdCapture?.statement).toContain("fence_epoch=fence_epoch+1");
      expect(holdCapture?.statement).toContain("AND fence_epoch=$5::bigint");
      expect(holdCapture?.values?.[4]).toBe("7");
      const journal = sql.writes.find((write) =>
        write.statement.includes("INSERT INTO platform.credit_journal_transaction"));
      expect(journal?.values?.[7]).toBe(databaseJournalDigest([
        [0, "site-1", "00000000-0000-7000-8000-000000000001", "credit_micros", "debit", "customer_reserved", 14, "00000000-0000-7000-8000-000000000101", "00000000-0000-7000-8000-000000000201"],
        [1, "site-1", "00000000-0000-7000-8000-000000000001", "credit_micros", "credit", "customer_consumed", 14, "00000000-0000-7000-8000-000000000101", "00000000-0000-7000-8000-000000000201"],
      ]));
    } finally { revokePlatformTransaction(lease); }
  });

  it("appends a source-balanced correction without mutating prior Usage, Settlement or Journal", async () => {
    const sql = new RecordingSql();
    const lease = issuePlatformTransaction(sql);
    try {
      const { allocation: _allocation, ratingPendingSegment: _pending, segment: _segment,
        ...base } = settlementRecord();
      const record = { ...base, priorSettlementRef: "00000000-0000-7000-8000-000000000700",
        sourceMutations: [{ creditGrantId: "00000000-0000-7000-8000-000000000101",
          ordinal: 0, amount: 5n, direction: "decrease" as const }] };
      await repository().persistSettlement(lease.transaction, record);
      expect(sql.writeSql()).toContain("'correction'");
      expect(sql.writes.filter((write) => write.statement.includes("credit_journal_entry"))).toHaveLength(4);
      expect(sql.writeSql()).toContain("captured_amount=captured_amount+$1::numeric");
      expect(sql.writeSql()).not.toMatch(/UPDATE platform\.credit_(attempt_usage_evidence|usage_settlement|journal)/u);
    } finally { revokePlatformTransaction(lease); }
  });

  it("freezes Segment, Root and Hold when first closure needs reconciliation", async () => {
    const sql = new RecordingSql();
    const lease = issuePlatformTransaction(sql);
    try {
      const settled = settlementRecord();
      const record: UsageReconciliationRecord = {
        identity: settled.identity,
        context: settled.context,
        closureRef: settled.receipt.closureRef,
        closureRevision: 1n,
        closureDigest: settled.closureDigest,
        closedAt: settled.closedAt,
        correctionOfClosureRef: null,
        evidenceSet: settled.evidenceSet,
        segment: {
          ...settled.context.segment,
          state: "reconciliation_required",
          resolutionKind: "outcome_unknown",
          resolutionRef: settled.receipt.closureRef,
          aggregateVersion: settled.context.segment.aggregateVersion + 1n,
          fenceEpoch: settled.context.segment.fenceEpoch + 1n,
        },
        code: "CREDIT_USAGE_UNAVAILABLE",
        observedAt: NOW,
        receiptRef: settled.receiptRef,
      };

      await repository().persistReconciliationRequired(lease.transaction, record);

      const statements = sql.writeSql();
      expect(statements).toMatch(
        /UPDATE platform\.credit_authorization_segment[\s\S]+UPDATE platform\.credit_execution_budget_root[\s\S]+UPDATE platform\.credit_hold/u,
      );
      expect(statements).toMatch(
        /credit_usage_segment_closure[\s\S]+credit_usage_reconciliation[\s\S]+credit_usage_command_receipt/u,
      );
    } finally {
      revokePlatformTransaction(lease);
    }
  });
});

class RecordingSql {
  reads: { statement: string; values?: readonly unknown[] }[] = [];
  writes: { statement: string; values?: readonly unknown[] }[] = [];
  async query<Row extends Record<string, unknown>>(
    statement: string,
    values?: readonly unknown[],
  ): Promise<readonly Row[]> {
    this.reads.push(values === undefined ? { statement } : { statement, values });
    return [];
  }
  async execute(statement: string, values?: readonly unknown[]): Promise<number> {
    this.writes.push(values === undefined ? { statement } : { statement, values });
    return 1;
  }
  writeSql() { return this.writes.map((write) => write.statement).join("\n"); }
}

function databaseJournalDigest(entries: readonly (readonly (string | number)[])[]): string {
  const canonical = entries.flatMap((entry) => entry.map((field) => {
    const value = String(field);
    return `${Buffer.byteLength(value, "utf8")}:${value}`;
  })).join("");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function repository() {
  let counter = 800;
  return new PostgresUsageSettlementRepository({
    reference: () => `00000000-0000-7000-8000-${String(counter++).padStart(12, "0")}`,
  });
}

function evidenceRecord() {
  return {
    identity: { siteId: "site-1", operationKind: "finalize_attempt" as const,
      businessOperationKey: "usage:1", requestDigest: "a".repeat(64) },
    siteId: "site-1", attemptAuthorizationRef: "00000000-0000-7000-8000-000000000300",
    executionBudgetRootRef: "00000000-0000-7000-8000-000000000202",
    budgetAllocationRef: "00000000-0000-7000-8000-000000000203",
    creditHoldRef: "00000000-0000-7000-8000-000000000201",
    creditAccountId: "00000000-0000-7000-8000-000000000001", unit: "credit_micros",
    evidenceRef: "00000000-0000-7000-8000-000000000301", businessOperationKey: "usage:1",
    requestDigest: "a".repeat(64), evidenceDigest: "b".repeat(64), observedAt: NOW,
    receiptRef: "00000000-0000-7000-8000-000000000302",
    priorAttemptState: "effect_committed" as const, priorFenceEpoch: 1n, nextFenceEpoch: 2n,
    provisionalCustomerAmount: 14n,
    evidence: { producerKind: "model_gateway" as const, producerContext: "gateway:one", producerGeneration: 1n,
      attemptRef: "attempt-1", logicalEffectRef: "effect-1",
      authorizationSegmentRef: "00000000-0000-7000-8000-000000000205",
      executionManifestRef: "manifest-1", revision: 1n, correctionOfEvidenceRef: null,
      attemptOutcome: "succeeded" as const, occurredAt: NOW, sourceDigest: "c".repeat(64),
      evidenceKind: "measured" as const,
      dimensions: [{ dimensionKey: "input_tokens", sourceUnit: "token", quantity: 1000n }] },
  };
}

function attemptIntentRecord() {
  return {
    identity: { siteId: "site-1", operationKind: "prepare_attempt" as const,
      businessOperationKey: "attempt:prepare:1", requestDigest: "1".repeat(64) },
    receipt: { attemptAuthorizationRef: "00000000-0000-7000-8000-000000000300",
      state: "effect_committed" as const, fenceEpoch: 1n },
    siteId: "site-1", executionBudgetRootRef: "00000000-0000-7000-8000-000000000202",
    budgetAllocationRef: "00000000-0000-7000-8000-000000000203",
    authorizationSegmentRef: "00000000-0000-7000-8000-000000000205",
    creditHoldRef: "00000000-0000-7000-8000-000000000201",
    creditAccountId: "00000000-0000-7000-8000-000000000001", unit: "credit_micros",
    executionManifestRef: "manifest-1", attemptAuthorizationRef: "00000000-0000-7000-8000-000000000300",
    producerKind: "model_gateway" as const, producerContext: "gateway:one", producerGeneration: 1n,
    attemptRef: "attempt-1", logicalEffectRef: "effect-1", maximumAmount: 25n,
    maximumDimensions: [{ dimensionKey: "input_tokens", sourceUnit: "token", quantity: 1000n }],
    maximumDimensionsDigest: "3".repeat(64),
    provisionalCustomerAmount: null,
    state: "effect_committed" as const, fenceEpoch: 1n, ownerEvidenceRef: null,
    committedAt: NOW, observedAt: NOW,
    receiptRef: "00000000-0000-7000-8000-000000000302",
  };
}

function settlementRecord(): UsageSettlementRecord {
  const context = {
    siteId: "site-1", billingAccountId: "billing-1",
    creditAccountId: "00000000-0000-7000-8000-000000000001", unit: "credit_micros",
    liabilityMerchantAccountId: "merchant-1", ratingPolicyRevisionRef: "rating-1",
    ratingSnapshotRef: null,
    executionBudgetRootRef: "00000000-0000-7000-8000-000000000202",
    executionBudgetRootState: "open" as const, executionBudgetRootVersion: 1n,
    creditHoldRef: "00000000-0000-7000-8000-000000000201", creditHoldState: "open" as const,
    creditHoldFenceEpoch: 7n, budgetAllocationRef: "00000000-0000-7000-8000-000000000203",
    authorizationSegmentRef: "00000000-0000-7000-8000-000000000205",
    executionManifestRef: "manifest-1", expiresAt: NOW,
    consumptionScope: { surfaceRef: "chat", capabilityKey: "chat.general", agentRef: null },
    allocation: { revision: 2n, allocationEpoch: 1n, creditCeiling: 100n, unassignedStock: 75n,
      activeChildReservedStock: 0n, committedStock: 25n, capturedCumulative: 0n,
      returnedToParentCumulative: 0n, state: "active" as const },
    segment: { state: "committed" as const, maximumAmount: 25n, allocationEpoch: 1n,
      preparedAgainstAllocationRevision: 1n, committedFromAllocationRevision: 1n,
      committedToAllocationRevision: 2n, aggregateVersion: 2n, fenceEpoch: 2n,
      resolutionKind: null, resolutionRef: null, committedAt: NOW, settledAt: null, releasedAt: null },
    ratingPolicy: { ratingPolicyRevisionRef: "rating-1", customerUnit: "credit_micros",
      chargeableAttemptOutcomes: ["succeeded" as const], minimumAmount: 0n,
      rules: [{ dimensionKey: "input_tokens", sourceUnit: "token", quantum: 1000n,
        amountPerQuantum: 14n, required: true }] },
  };
  return {
    identity: { siteId: "site-1", operationKind: "settle_usage", businessOperationKey: "settle:1",
      requestDigest: "d".repeat(64) }, context,
    receipt: { settlementRef: "00000000-0000-7000-8000-000000000500",
      authorizationSegmentRef: context.authorizationSegmentRef,
      authorizationSegmentVersion: 4n,
      closureRef: "00000000-0000-7000-8000-000000000400", closureRevision: 1n,
      state: "settled", customerAmount: 14n, platformExposureAmount: 0n },
    allocation: { ...context.allocation, revision: 3n, unassignedStock: 86n,
      committedStock: 0n, capturedCumulative: 14n },
    ratingPendingSegment: { ...context.segment, state: "rating_pending", aggregateVersion: 3n, fenceEpoch: 3n },
    segment: { ...context.segment, state: "settled", resolutionKind: "rated",
      resolutionRef: "00000000-0000-7000-8000-000000000400", aggregateVersion: 4n, fenceEpoch: 4n,
      settledAt: NOW },
    closureDigest: "e".repeat(64), closedAt: NOW, correctionOfClosureRef: null,
    ratingSnapshotRef: "00000000-0000-7000-8000-000000000600", ratingSnapshotDigest: "f".repeat(64),
    evidenceSet: [evidenceRecord()],
    attemptRatings: [{ producerKind: "model_gateway", producerContext: "gateway:one", producerGeneration: 1n,
      attemptRef: "attempt-1", logicalEffectRef: "effect-1", policyRatedAmount: 14n,
      lineItems: [{ dimensionKey: "input_tokens", quantity: 1000n, billableQuanta: 1n, amount: 14n }] }],
    sourceMutations: [{ creditGrantId: "00000000-0000-7000-8000-000000000101",
      ordinal: 0, amount: 14n, direction: "capture" }],
    policyRatedAmount: 14n, customerAmount: 14n, platformExposureAmount: 0n, settledAt: NOW,
    journalTransactionRef: "00000000-0000-7000-8000-000000000700",
    receiptRef: "00000000-0000-7000-8000-000000000701",
  };
}

const NOW = "2026-07-29T00:10:00.000Z";
