import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MemoryApplicationError,
  MemoryPublicReadOwner,
  memoryPublicPersonalContext,
  type MemoryPublicCursorCodec,
  type MemoryPublicEntryRecord,
  type MemoryPublicRepository,
  type MemoryPublicRevisionRecord,
} from "../../src/modules/memory/index.js";
import { createProtectedMemoryContent } from "../../src/modules/memory/index.js";
import { issuePlatformTransaction, revokePlatformTransaction,
  type PlatformTransactionLease } from "../../src/shared/unit-of-work/platform-transaction.js";

const context = memoryPublicPersonalContext({ siteRef: "site-alpha", subjectRef: "subject-alpha",
  subjectGeneration: 3n, featurePolicyRevisionRef: "feature-policy-r7" });
const protectedContent = createProtectedMemoryContent({ envelopeVersion: 1,
  ciphertext: new Uint8Array([1]), keyRevision: "key-r1", nonce: new Uint8Array(12),
  authenticationTag: new Uint8Array(16), aadDigest: "a".repeat(64) });
const MAX_RESPONSE_BYTES = 262_144;

describe("MemoryPublicReadOwner", () => {
  let lease: PlatformTransactionLease;
  let rows: MemoryPublicEntryRecord[];
  let repository: MemoryPublicRepository;
  let encoded: unknown[];
  let decoded: unknown;
  let cursors: MemoryPublicCursorCodec;

  beforeEach(() => {
    lease = issuePlatformTransaction({ query: async () => [], execute: async () => 0 });
    rows = [entry("entry-a", true, "2026-07-31T11:00:00.000Z"),
      entry("entry-b", false, "2026-07-31T10:00:00.000Z")];
    repository = {
      recoverCommand: async () => ({ kind: "continue", requestPayloadKeyRevision: "replay-r1",
        requestPayloadDigest: "a".repeat(64) }),
      claimCommand: async () => ({ kind: "continue", requestPayloadKeyRevision: "replay-r1",
        requestPayloadDigest: "a".repeat(64) }),
      executeCommand: async () => { throw new Error("unused"); },
      resolveOwner: async () => ({ context, spaceRef: "space-user-1", spaceVersion: 7n }),
      listEntries: async () => rows,
      getEntry: async () => rows[0] ?? null,
      listHistory: async () => ({ entry: rows[0]!, revisions: [] }),
    };
    encoded = [];
    decoded = null;
    cursors = {
      encode: (value) => { encoded.push(value); return "sealed-cursor"; },
      decode: () => decoded as never,
    };
  });

  afterEach(() => revokePlatformTransaction(lease));

  it("issues one snapshot and binds continuation to personal scope, filters, order, version, and expiry", async () => {
    rows.push(entry("entry-c", false, "2026-07-31T09:00:00.000Z"));
    const owner = createOwner(repository, cursors, lease);
    const first = await owner.list({ context, category: "fact", source: "explicit", limit: 2 });
    expect(first.ownerSnapshot).toEqual({ snapshotRef: expect.any(String), spaceVersion: 7n });
    expect(first.items.map(({ entryRef }) => entryRef)).toEqual(["entry-a", "entry-b"]);
    expect(first.pageInfo).toEqual({ hasMore: true, nextCursor: "sealed-cursor" });
    expect(encoded[0]).toMatchObject({ kind: "entries", context,
      filter: { state: "active", category: "fact", source: "explicit" },
      order: "priority_updated_entry_desc", spaceVersion: 7n,
      snapshotRef: first.ownerSnapshot.snapshotRef, prioritized: false, entryRef: "entry-b" });

    decoded = { ...(encoded[0] as object), expiresAt: "2026-07-31T12:05:00.000Z" };
    rows = [];
    const continued = await owner.list({ context, category: "fact", source: "explicit",
      limit: 2, cursor: "sealed-cursor" });
    expect(continued.ownerSnapshot).toEqual(first.ownerSnapshot);
  });

  it("normalizes absent list filters to the implicit-active all-values cursor binding", async () => {
    rows.push(entry("entry-c", false, "2026-07-31T09:00:00.000Z"));
    await createOwner(repository, cursors, lease).list({ context, limit: 2 });
    expect(encoded[0]).toMatchObject({
      filter: { state: "active", category: null, source: null },
    });
  });

  it("rejects a continuation when the monotonic owner version changed", async () => {
    decoded = { kind: "entries", context,
      filter: { state: "active", category: null, source: null },
      order: "priority_updated_entry_desc", spaceVersion: 6n, snapshotRef: "snapshot-old",
      prioritized: false, updatedAt: "2026-07-31T10:00:00.000Z", entryRef: "entry-b",
      expiresAt: "2026-07-31T12:05:00.000Z" };
    await expect(createOwner(repository, cursors, lease).list({ context, cursor: "old", limit: 2 }))
      .rejects.toEqual(new MemoryApplicationError("MEMORY_OWNER_SNAPSHOT_STALE"));
  });

  it("returns observedSpaceVersion for detail and collapses missing/cross-owner access", async () => {
    const owner = createOwner(repository, cursors, lease);
    await expect(owner.get({ context, entryRef: "entry-a" })).resolves.toMatchObject({
      observedSpaceVersion: 7n, entry: { entryRef: "entry-a", content: "safe content" },
    });
    repository.getEntry = async () => null;
    await expect(owner.get({ context, entryRef: "entry-other" })).rejects.toEqual(
      new MemoryApplicationError("MEMORY_PUBLIC_NOT_AVAILABLE"),
    );
  });

  it("keeps revokedAt and purgedAt as distinct content-free lifecycle facts", async () => {
    const owner = createOwner(repository, cursors, lease);
    repository.getEntry = async () => ({ ...entry("entry-a", false,
      "2026-07-31T10:00:00.000Z"), state: "revoked_purge_pending",
    protectedContent: null, purgeReceiptRef: "purge-receipt-a",
    revokedAt: "2026-07-31T11:00:00.000Z" });
    await expect(owner.get({ context, entryRef: "entry-a" })).resolves.toEqual({
      observedSpaceVersion: 7n,
      entry: { entryRef: "entry-a", state: "revoked_purge_pending",
        purgeReceiptRef: "purge-receipt-a", revokedAt: "2026-07-31T11:00:00.000Z" },
    });

    repository.getEntry = async () => ({ ...entry("entry-a", false,
      "2026-07-31T10:00:00.000Z"), state: "purged", protectedContent: null,
    purgeReceiptRef: "purge-receipt-a", purgedAt: "2026-07-31T12:00:00.000Z" });
    await expect(owner.get({ context, entryRef: "entry-a" })).resolves.toEqual({
      observedSpaceVersion: 7n,
      entry: { entryRef: "entry-a", state: "purged", purgeReceiptRef: "purge-receipt-a",
        purgedAt: "2026-07-31T12:00:00.000Z" },
    });

    repository.getEntry = async () => ({ ...entry("entry-a", false,
      "2026-07-31T10:00:00.000Z"), state: "purged", protectedContent: null,
    purgeReceiptRef: "purge-receipt-a", revokedAt: "2026-07-31T11:00:00.000Z",
    purgedAt: "2026-07-31T12:00:00.000Z" });
    await expect(owner.get({ context, entryRef: "entry-a" })).rejects.toEqual(
      new MemoryApplicationError("MEMORY_PUBLIC_NOT_AVAILABLE"),
    );
  });

  it("returns history with the same version-bound owner snapshot and enforces item/byte caps", async () => {
    repository.listHistory = async () => ({ entry: rows[0]!, revisions: Array.from({ length: 101 }, (_, i) => ({
      revision: BigInt(101 - i), revisionRef: `revision-${101 - i}`, reason: "corrected" as const,
      supersedesRevisionRef: `revision-${100 - i}`,
      restoredFromRevisionRef: null, validFrom: null, validTo: null,
      recordedAt: "2026-07-31T11:00:00.000Z", protectedContent,
    })) });
    const result = await createOwner(repository, cursors, lease).history({ context,
      entryRef: "entry-a", limit: 100 });
    expect(result.items.length).toBeLessThanOrEqual(100);
    expect(result.ownerSnapshot.spaceVersion).toBe(7n);
    expect(Buffer.byteLength(JSON.stringify(result, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value))).toBeLessThanOrEqual(262_144);
  });

  it("never reveals retained payload bytes after the entry is logically revoked", async () => {
    let revealCalls = 0;
    const revoked = { ...entry("entry-a", false, "2026-07-31T10:00:00.000Z"),
      state: "revoked_purge_pending" as const, protectedContent: null,
      purgeReceiptRef: "purge-receipt-a", revokedAt: "2026-07-31T11:00:00.000Z" };
    repository.listHistory = async () => ({ entry: revoked, revisions: [revision(1)] });
    const result = await createOwner(repository, cursors, lease, { onReveal: () => { revealCalls += 1; } })
      .history({ context, entryRef: "entry-a" });
    expect(result.items).toEqual([{ revision: 1, revisionRef: "revision-1", reason: "explicit",
      recordedAt: "2026-07-31T11:00:00.000Z", state: "purged", restorable: false }]);
    expect(revealCalls).toBe(0);
  });

  it("measures the complete list envelope just below and above the UTF-8 cap", async () => {
    rows = boundaryEntries();
    for (const target of [MAX_RESPONSE_BYTES - 1, MAX_RESPONSE_BYTES + 1]) {
      const contents = exactContents(target, rows.length, (candidate) => listEnvelope(rows, candidate));
      const contentByRevisionRef = new Map(rows.map((row, index) =>
        [row.currentRevisionRef, contents[index]!] as const));
      expect(responseBytes(listEnvelope(rows, contents))).toBe(target);
      const result = await createOwner(repository, cursors, lease, { contentByRevisionRef })
        .list({ context, limit: rows.length });
      expect(responseBytes(result)).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
      if (target < MAX_RESPONSE_BYTES) {
        expect(result.items).toHaveLength(rows.length);
        expect(result.pageInfo).toEqual({ hasMore: false, nextCursor: null });
      } else {
        expect(result.items).toHaveLength(rows.length - 1);
        expect(result.pageInfo).toEqual({ hasMore: true, nextCursor: "sealed-cursor" });
      }
    }
  });

  it("measures the complete history envelope just below and above the UTF-8 cap", async () => {
    const revisions = boundaryRevisions();
    repository.listHistory = async () => ({ entry: rows[0]!, revisions });
    for (const target of [MAX_RESPONSE_BYTES - 1, MAX_RESPONSE_BYTES + 1]) {
      const contents = exactContents(target, revisions.length,
        (candidate) => historyEnvelope(revisions, candidate));
      const contentByRevisionRef = new Map(revisions.map((revision, index) =>
        [revision.revisionRef, contents[index]!] as const));
      expect(responseBytes(historyEnvelope(revisions, contents))).toBe(target);
      const result = await createOwner(repository, cursors, lease, { contentByRevisionRef })
        .history({ context, entryRef: "entry-a", limit: revisions.length });
      expect(responseBytes(result)).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
      if (target < MAX_RESPONSE_BYTES) {
        expect(result.items).toHaveLength(revisions.length);
        expect(result.pageInfo).toEqual({ hasMore: false, nextCursor: null });
      } else {
        expect(result.items).toHaveLength(revisions.length - 1);
        expect(result.pageInfo).toEqual({ hasMore: true, nextCursor: "sealed-cursor" });
      }
    }
  });

  it("fails closed when one list or history item cannot fit by itself", async () => {
    const oversized = "x".repeat(MAX_RESPONSE_BYTES);
    rows = [entry("entry-oversized", false, "2026-07-31T11:00:00.000Z")];
    let contentByRevisionRef = new Map([[rows[0]!.currentRevisionRef, oversized]]);
    await expect(createOwner(repository, cursors, lease, { contentByRevisionRef })
      .list({ context, limit: 1 })).rejects.toEqual(
      new MemoryApplicationError("MEMORY_PERSISTENCE_CONFLICT"),
    );

    const revisions = [revision(1)];
    repository.listHistory = async () => ({ entry: rows[0]!, revisions });
    contentByRevisionRef = new Map([[revisions[0]!.revisionRef, oversized]]);
    await expect(createOwner(repository, cursors, lease, { contentByRevisionRef })
      .history({ context, entryRef: "entry-oversized", limit: 1 })).rejects.toEqual(
      new MemoryApplicationError("MEMORY_PERSISTENCE_CONFLICT"),
    );
  });

  it("fails closed when the continuation cursor alone would exceed the response cap", async () => {
    rows = [entry("entry-b", false, "2026-07-31T11:00:00.000Z"),
      entry("entry-a", false, "2026-07-31T10:00:00.000Z")];
    cursors.encode = (value) => { encoded.push(value); return "c".repeat(MAX_RESPONSE_BYTES); };
    await expect(createOwner(repository, cursors, lease).list({ context, limit: 1 })).rejects.toEqual(
      new MemoryApplicationError("MEMORY_PERSISTENCE_CONFLICT"),
    );
  });

  it("returns complete bounded envelopes for empty list and history pages", async () => {
    rows = [];
    const owner = createOwner(repository, cursors, lease);
    const list = await owner.list({ context });
    expect(list).toMatchObject({ items: [], pageInfo: { hasMore: false, nextCursor: null } });
    expect(responseBytes(list)).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);

    repository.listHistory = async () => ({
      entry: entry("entry-empty", false, "2026-07-31T11:00:00.000Z"), revisions: [],
    });
    const history = await owner.history({ context, entryRef: "entry-empty" });
    expect(history).toMatchObject({ items: [], pageInfo: { hasMore: false, nextCursor: null } });
    expect(responseBytes(history)).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
  });
});

function entry(entryRef: string, prioritized: boolean, updatedAt: string): MemoryPublicEntryRecord {
  return Object.freeze({ entryRef, entryVersion: 1n, category: "fact", state: "active",
    prioritized, revision: 1n, currentRevisionRef: `revision-${entryRef}`, reason: "explicit",
    validFrom: null, validTo: null, createdAt: updatedAt, updatedAt, protectedContent,
    sourceKind: "explicit", sourceState: "current", safeSourceLabel: "Saved by you" });
}

function createOwner(repository: MemoryPublicRepository, cursors: MemoryPublicCursorCodec,
  lease: PlatformTransactionLease, options: Readonly<{
    contentByRevisionRef?: ReadonlyMap<string, string>;
    onReveal?: () => void;
  }> = {}) {
  return new MemoryPublicReadOwner({ repository, cursors,
    protector: { protect: async () => protectedContent,
      reveal: async ({ binding }) => {
        options.onReveal?.();
        return new TextEncoder().encode(
          options.contentByRevisionRef?.get(binding.revisionRef) ?? "safe content",
        );
      } },
    unitOfWork: { execute: async (_fence, work) => work(lease.transaction) },
    clock: () => new Date("2026-07-31T12:00:00.000Z"),
    reference: () => "snapshot-00000001" });
}

function boundaryEntries(): MemoryPublicEntryRecord[] {
  return Array.from({ length: 16 }, (_, index) => entry(`entry-${16 - index}`, false,
    new Date(Date.parse("2026-07-31T11:00:00.000Z") - index * 1_000).toISOString()));
}

function revision(number: number): MemoryPublicRevisionRecord {
  return Object.freeze({ revision: BigInt(number), revisionRef: `revision-${number}`,
    reason: number === 1 ? "explicit" as const : "corrected" as const,
    supersedesRevisionRef: number === 1 ? null : `revision-${number - 1}`,
    restoredFromRevisionRef: null, validFrom: null, validTo: null,
    recordedAt: "2026-07-31T11:00:00.000Z", protectedContent });
}

function boundaryRevisions(): MemoryPublicRevisionRecord[] {
  return Array.from({ length: 16 }, (_, index) => revision(16 - index));
}

function exactContents(targetBytes: number, count: number,
  envelope: (contents: readonly string[]) => unknown): string[] {
  const contents = Array.from({ length: count }, (_, index) =>
    index === count - 1 ? "" : "x".repeat(16_384));
  const remainder = targetBytes - responseBytes(envelope(contents));
  if (remainder < 0 || remainder > 16_384) throw new Error("MEMORY_TEST_BOUNDARY_FIXTURE_INVALID");
  contents[count - 1] = "x".repeat(remainder);
  if (responseBytes(envelope(contents)) !== targetBytes) {
    throw new Error("MEMORY_TEST_BOUNDARY_FIXTURE_INVALID");
  }
  return contents;
}

function listEnvelope(entries: readonly MemoryPublicEntryRecord[], contents: readonly string[]) {
  return { items: entries.map((row, index) => entryView(row, contents[index]!)),
    ownerSnapshot: { snapshotRef: "snapshot-00000001", spaceVersion: 7n },
    pageInfo: { hasMore: false, nextCursor: null } };
}

function entryView(row: MemoryPublicEntryRecord, content: string) {
  return { entryRef: row.entryRef, entryVersion: row.entryVersion, state: "active",
    scopeKind: "user", category: row.category, content, prioritized: row.prioritized,
    revision: Number(row.revision), currentRevisionRef: row.currentRevisionRef,
    validFrom: row.validFrom, validTo: row.validTo, source: { sourceKind: row.sourceKind,
      state: row.sourceState, safeLabel: row.safeSourceLabel }, createdAt: row.createdAt,
    updatedAt: row.updatedAt };
}

function historyEnvelope(revisions: readonly MemoryPublicRevisionRecord[], contents: readonly string[]) {
  return { entryRef: "entry-a",
    items: revisions.map((row, index) => revisionView(row, contents[index]!)),
    ownerSnapshot: { snapshotRef: "snapshot-00000001", spaceVersion: 7n },
    pageInfo: { hasMore: false, nextCursor: null } };
}

function revisionView(row: MemoryPublicRevisionRecord, content: string) {
  return { revision: Number(row.revision), revisionRef: row.revisionRef, reason: row.reason,
    recordedAt: row.recordedAt, state: "available", restorable: true, content,
    supersedesRevisionRef: row.supersedesRevisionRef, validFrom: row.validFrom,
    validTo: row.validTo };
}

function responseBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? item.toString() : item), "utf8");
}
