import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MemoryApplicationError,
  MemoryPublicReadOwner,
  memoryPublicPersonalContext,
  type MemoryPublicCursorCodec,
  type MemoryPublicEntryRecord,
  type MemoryPublicRepository,
} from "../../src/modules/memory/index.js";
import { createProtectedMemoryContent } from "../../src/modules/memory/index.js";
import { issuePlatformTransaction, revokePlatformTransaction,
  type PlatformTransactionLease } from "../../src/shared/unit-of-work/platform-transaction.js";

const context = memoryPublicPersonalContext({ siteRef: "site-alpha", subjectRef: "subject-alpha",
  subjectGeneration: 3n, featurePolicyRevisionRef: "feature-policy-r7" });
const protectedContent = createProtectedMemoryContent({ envelopeVersion: 1,
  ciphertext: new Uint8Array([1]), keyRevision: "key-r1", nonce: new Uint8Array(12),
  authenticationTag: new Uint8Array(16), aadDigest: "a".repeat(64) });

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
    expect(encoded[0]).toMatchObject({ kind: "entries", context, category: "fact",
      source: "explicit", order: "priority_updated_entry_desc", spaceVersion: 7n,
      snapshotRef: first.ownerSnapshot.snapshotRef, prioritized: false, entryRef: "entry-b" });

    decoded = { ...(encoded[0] as object), expiresAt: "2026-07-31T12:05:00.000Z" };
    rows = [];
    const continued = await owner.list({ context, category: "fact", source: "explicit",
      limit: 2, cursor: "sealed-cursor" });
    expect(continued.ownerSnapshot).toEqual(first.ownerSnapshot);
  });

  it("rejects a continuation when the monotonic owner version changed", async () => {
    decoded = { kind: "entries", context, category: null, source: null,
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
});

function entry(entryRef: string, prioritized: boolean, updatedAt: string): MemoryPublicEntryRecord {
  return Object.freeze({ entryRef, entryVersion: 1n, category: "fact", state: "active",
    prioritized, revision: 1n, currentRevisionRef: `revision-${entryRef}`, reason: "explicit",
    validFrom: null, validTo: null, createdAt: updatedAt, updatedAt, protectedContent,
    sourceKind: "explicit", sourceState: "current", safeSourceLabel: "Saved by you" });
}

function createOwner(repository: MemoryPublicRepository, cursors: MemoryPublicCursorCodec,
  lease: PlatformTransactionLease) {
  return new MemoryPublicReadOwner({ repository, cursors,
    protector: { protect: async () => protectedContent,
      reveal: async () => new TextEncoder().encode("safe content") },
    unitOfWork: { execute: async (_fence, work) => work(lease.transaction) },
    clock: () => new Date("2026-07-31T12:00:00.000Z"),
    reference: () => "snapshot-00000001" });
}
