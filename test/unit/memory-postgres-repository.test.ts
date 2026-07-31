import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MemoryApplicationError,
  PostgresMemoryAuthorityRepository,
  correctMemoryEntry,
  createMemorySpace,
  createProtectedMemoryContent,
  createRememberedMemory,
  memoryCommandRef,
  memoryDigest,
  memoryReceiptOwner,
  memorySiteRef,
  memorySpaceRef,
  rehydrateMemoryActorAuthorization,
  pauseMemoryLearning,
  type MemoryCommandReceiptIdentity,
} from "../../src/modules/memory/index.js";
import { issuePlatformTransaction, revokePlatformTransaction,
  type PlatformSqlTransaction, type PlatformTransactionLease } from
  "../../src/shared/unit-of-work/platform-transaction.js";

const binding = Object.freeze({ kind: "user" as const, siteRef: "site-alpha",
  subjectRef: "subject-alpha", subjectGeneration: 3n });

function content(bytes: readonly number[]) {
  return createProtectedMemoryContent({ envelopeVersion: 1, ciphertext: new Uint8Array(bytes),
    keyRevision: "memory-key-r2", nonce: new Uint8Array(12).fill(1),
    authenticationTag: new Uint8Array(16).fill(2), aadDigest: "a".repeat(64) });
}

function identity(): MemoryCommandReceiptIdentity {
  return Object.freeze({ owner: memoryReceiptOwner(createMemorySpace({ spaceRef: "space-user-1", binding,
    featurePolicyRevisionRef: "feature-policy-r7",
    recordedAt: "2026-07-30T12:00:00.000Z" }).binding),
  actorAuthorization: rehydrateMemoryActorAuthorization(binding),
  commandRef: memoryCommandRef("command-1"), operation: "remember",
  requestDigest: memoryDigest("b".repeat(64)) });
}

describe("PostgresMemoryAuthorityRepository", () => {
  let statements: Array<Readonly<{ statement: string; values: readonly unknown[] }>>;
  let receiptRows: readonly Record<string, unknown>[];
  let executeResult: number;
  let lease: PlatformTransactionLease;
  let repository: PostgresMemoryAuthorityRepository;

  beforeEach(() => {
    statements = [];
    receiptRows = [];
    executeResult = 1;
    const sql: PlatformSqlTransaction = {
      query: async <Row extends Record<string, unknown>>(statement: string,
        values: readonly unknown[] = []) => {
        statements.push({ statement, values });
        if (statement.includes("FROM platform.memory_command_receipt")) {
          return receiptRows as readonly Row[];
        }
        return [];
      },
      execute: async (statement, values = []) => {
        statements.push({ statement, values });
        return executeResult;
      },
    };
    lease = issuePlatformTransaction(sql);
    repository = new PostgresMemoryAuthorityRepository();
  });

  afterEach(() => revokePlatformTransaction(lease));

  it("locks a declared parent before its child authority row", async () => {
    await repository.loadSpaceAuthorityForUpdate(lease.transaction, memorySiteRef("site-alpha"),
      memorySpaceRef("child-space"), memorySpaceRef("parent-space"));
    const locks = statements.filter(({ statement }) => statement.includes("platform.memory_space"));
    expect(locks).toHaveLength(3);
    expect(locks[0]?.values).toEqual(["site-alpha", "child-space"]);
    expect(locks[0]?.statement).not.toContain("FOR UPDATE");
    expect(locks[1]?.values).toEqual(["site-alpha", "parent-space"]);
    expect(locks[1]?.statement).toContain("FOR UPDATE");
    expect(locks[2]?.values).toEqual(["site-alpha", "child-space"]);
    expect(locks[2]?.statement).toContain("FOR UPDATE");
  });

  it("serializes owner-scoped receipt claims and decodes only the closed result union", async () => {
    expect(await repository.claimReceipt(lease.transaction, identity())).toEqual({ kind: "claimed" });
    expect(statements[0]?.statement).toContain("pg_catalog.pg_advisory_xact_lock");
    receiptRows = [{
      operation: "remember", requestDigest: "b".repeat(64), resultKind: "remembered",
      resultSpaceRef: "space-user-1",
      resultSpaceVersion: 1n, resultEntryRef: "memory-entry-1", resultEntryVersion: 1n,
      resultRevisionRef: "memory-revision-1", resultRevision: 1n,
      resultSpaceGeneration: null, resultLearningGeneration: null, resultRevocationEpoch: null,
      resultMinimumSourceOriginSequence: null, resultLearningState: null, resultUseState: null,
      resultPreviousFeaturePolicyRevisionRef: null, resultFeaturePolicyRevisionRef: null,
    }];
    await expect(repository.claimReceipt(lease.transaction, identity())).resolves.toEqual({
      kind: "replay",
      result: { kind: "remembered", spaceRef: "space-user-1", spaceVersion: 1n,
        entryRef: "memory-entry-1", entryVersion: 1n, revisionRef: "memory-revision-1", revision: 1n },
    });

    receiptRows = [{ ...receiptRows[0], resultKind: "forgotten", resultRevisionRef: "leaked-ref" }];
    await expect(repository.claimReceipt(lease.transaction, identity())).rejects.toMatchObject({
      code: "MEMORY_RECEIPT_INVALID",
    });
  });

  it("returns a typed digest conflict without exposing the stored result", async () => {
    receiptRows = [{ operation: "remember", requestDigest: "c".repeat(64),
      resultKind: "remembered" }];
    await expect(repository.claimReceipt(lease.transaction, identity())).resolves.toEqual({
      kind: "digest_conflict",
    });
  });

  it("treats operation reuse under the same owner command and digest as a conflict", async () => {
    receiptRows = [{ operation: "correct", requestDigest: "b".repeat(64),
      resultKind: "corrected" }];
    await expect(repository.claimReceipt(lease.transaction, identity())).resolves.toEqual({
      kind: "digest_conflict",
    });
  });

  it("rejects a persisted operation/result combination outside the closed codec", async () => {
    receiptRows = [{
      operation: "remember", requestDigest: "b".repeat(64), resultKind: "corrected",
      resultSpaceRef: "space-user-1", resultSpaceVersion: 1n,
      resultEntryRef: "memory-entry-1", resultEntryVersion: 2n,
      resultRevisionRef: "memory-revision-2", resultRevision: 2n,
      resultSpaceGeneration: null, resultLearningGeneration: null, resultRevocationEpoch: null,
      resultMinimumSourceOriginSequence: null, resultLearningState: null, resultUseState: null,
      resultPreviousFeaturePolicyRevisionRef: null, resultFeaturePolicyRevisionRef: null,
    }];
    await expect(repository.claimReceipt(lease.transaction, identity())).rejects.toEqual(
      new MemoryApplicationError("MEMORY_RECEIPT_INVALID"),
    );
  });

  it("appends protected revision/provenance before a current-revision CAS", async () => {
    const space = createMemorySpace({ spaceRef: "space-user-1", binding,
      featurePolicyRevisionRef: "feature-policy-r7", recordedAt: "2026-07-30T12:00:00.000Z" });
    const remembered = createRememberedMemory({ space, entryRef: "memory-entry-1",
      revisionRef: "memory-revision-1", provenanceRef: "memory-provenance-1",
      sourceCommandRef: "command-1", sourceDigest: "c".repeat(64), protectedContent: content([1, 2]),
      category: "fact", featurePolicyRevisionRef: space.featurePolicyRevisionRef,
      actorAuthorization: binding,
      recordedAt: "2026-07-30T12:00:00.000Z" });
    const corrected = correctMemoryEntry({ space, entry: remembered.entry, expectedVersion: 1n,
      expectedCurrentRevision: 1n, revisionRef: "memory-revision-2",
      provenanceRef: "memory-provenance-2", sourceCommandRef: "command-2",
      sourceDigest: "d".repeat(64), protectedContent: content([3, 4]),
      featurePolicyRevisionRef: space.featurePolicyRevisionRef,
      actorAuthorization: binding,
      recordedAt: "2026-07-30T12:01:00.000Z" });

    await repository.saveCorrectedMemory(lease.transaction,
      { entryVersion: remembered.entry.version, currentRevision: remembered.entry.currentRevision }, corrected);
    const writes = statements.filter(({ statement }) => statement.startsWith("INSERT") ||
      statement.startsWith("UPDATE"));
    expect(writes.map(({ statement }) => statement.split("\n")[0])).toEqual([
      "INSERT INTO platform.memory_revision", "INSERT INTO platform.memory_revision_payload",
      "INSERT INTO platform.memory_provenance", "UPDATE platform.memory_entry",
    ]);
    expect(writes[0]?.values.some((value) => Buffer.isBuffer(value))).toBe(false);
    expect(writes[1]?.values.filter((value) => Buffer.isBuffer(value))).toHaveLength(3);
    expect(writes[3]?.statement).toContain("current_revision=$");
    expect(writes[3]?.statement).toContain("version=$");
  });

  it("turns a zero-row aggregate CAS into a typed persistence conflict", async () => {
    const space = createMemorySpace({ spaceRef: "space-user-1", binding,
      featurePolicyRevisionRef: "feature-policy-r7", recordedAt: "2026-07-30T12:00:00.000Z" });
    const paused = pauseMemoryLearning({ space, expectedVersion: space.version,
      changedAt: "2026-07-30T12:01:00.000Z" });
    executeResult = 0;
    await expect(repository.saveSpace(lease.transaction, space.version, paused)).rejects.toEqual(
      new MemoryApplicationError("MEMORY_PERSISTENCE_CONFLICT"),
    );
  });
});
