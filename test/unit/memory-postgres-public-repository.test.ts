import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PostgresMemoryPublicRepository, createMemoryReplayRequestVerifier,
  createProtectedMemoryContent, memoryPublicPersonalContext } from
  "../../src/modules/memory/index.js";
import { issuePlatformTransaction, revokePlatformTransaction,
  type PlatformSqlTransaction, type PlatformTransactionLease } from
  "../../src/shared/unit-of-work/platform-transaction.js";

const context = memoryPublicPersonalContext({ siteRef: "site-alpha", subjectRef: "subject-alpha",
  subjectGeneration: 3n, featurePolicyRevisionRef: "feature-policy-r7" });

describe("PostgresMemoryPublicRepository", () => {
  let lease: PlatformTransactionLease;
  let statements: Array<Readonly<{ sql: string; values: readonly unknown[] }>>;
  let rows: readonly Record<string, unknown>[];
  let repository: PostgresMemoryPublicRepository;

  beforeEach(() => {
    statements = [];
    rows = [];
    const sql: PlatformSqlTransaction = {
      query: async <Row extends Record<string, unknown>>(statement: string,
        values: readonly unknown[] = []) => {
        statements.push({ sql: statement, values });
        const prepare = /memory_public_prepare_(remember|correct|restore|prioritize|deprioritize|forget|reset)/u
          .exec(statement)?.[1];
        if (prepare !== undefined) {
          const needsSpace = prepare !== "remember";
          const needsEntry = prepare !== "remember" && prepare !== "reset";
          return [{ result: { decision: "claimed", spaceRef: "space-user-1",
            spaceVersion: needsSpace ? "1" : "1", persisted: needsSpace,
            prepareRef: `memory-prepare:${"c".repeat(64)}`,
            expectedStateDigest: "d".repeat(64),
            spaceState: needsSpace ? spaceState() : null,
            entryState: needsEntry ? entryState() : null,
            restoreRevisionState: prepare === "restore" ? { revision: "1",
              revisionRef: "revision-source", validFrom: null, validTo: null } : null } }] as unknown as Row[];
        }
        const commit = /memory_public_commit_(remember|correct|restore|prioritize|deprioritize|forget|reset)/u
          .exec(statement)?.[1];
        if (commit !== undefined) {
          const kind = commit === "restore" ? "restored"
            : commit === "forget" || commit === "reset" ? "purge" : "entry";
          return [{ result: { decision: "committed", kind,
            committedSpaceVersion: "7" } }] as unknown as Row[];
        }
        return rows as readonly Row[];
      },
      execute: async (statement, values = []) => {
        statements.push({ sql: statement, values }); return 1;
      },
    };
    lease = issuePlatformTransaction(sql);
    repository = new PostgresMemoryPublicRepository({ issue: async () => ({
      keyRevision: "memory-transition-r1", digest: "f".repeat(64),
    }) }, createMemoryReplayRequestVerifier({ active: {
      keyRevision: "memory-replay-r1", key: new Uint8Array(32).fill(7),
    } }));
  });

  afterEach(() => revokePlatformTransaction(lease));

  it("calls only operation-specific SECURITY DEFINER read routines", async () => {
    await repository.resolveOwner(lease.transaction, { context,
      operation: "list_entries", candidateSpaceRef: "memory-space:owner",
      now: "2026-07-31T12:00:00.000Z" });
    await repository.listEntries(lease.transaction, { owner: { context,
      spaceRef: "space-user-1", spaceVersion: 7n }, category: null, source: "import",
      after: null, limit: 51 });
    await repository.getEntry(lease.transaction, { owner: { context,
      spaceRef: "space-user-1", spaceVersion: 7n }, entryRef: "entry-1" });
    await repository.listHistory(lease.transaction, { owner: { context,
      spaceRef: "space-user-1", spaceVersion: 7n }, entryRef: "entry-1",
      revisionBefore: null, limit: 51 });

    expect(statements.map(({ sql }) => sql)).toEqual(expect.arrayContaining([
      expect.stringContaining("platform.memory_public_list_entries_owner"),
      expect.stringContaining("platform.memory_public_list_entries"),
      expect.stringContaining("platform.memory_public_get_entry"),
      expect.stringContaining("platform.memory_public_list_entry_history"),
    ]));
    for (const { sql } of statements) {
      expect(sql).not.toMatch(/\b(?:FROM|JOIN|UPDATE|INSERT INTO|DELETE FROM)\s+platform\.memory_/iu);
      expect(sql).not.toContain("memory_assert_public_owner_authority");
    }
    const listCall = statements.find(({ sql }) =>
      sql.includes("platform.memory_public_list_entries($1"));
    expect(listCall?.values[7]).toBe("import");
  });

  it("maps every mutation to a closed prepare/commit routine pair", async () => {
    const operations = ["remember", "correct", "restore", "prioritize", "deprioritize",
      "forget", "reset"] as const;
    for (const operation of operations) {
      rows = [{ decision: "claimed", spaceRef: "space-user-1", spaceVersion: "7" }];
      await repository.executeCommand(lease.transaction, {
        operation, context, commandRef: `command-${operation}`, requestDigest: "a".repeat(64),
        requestDigestKeyRevision: "memory-command-hmac-r1",
        requestPayloadDigest: "9".repeat(64), requestPayloadKeyRevision: "memory-replay-r1",
        spaceRef: "space-user-1", entryRef: operation === "reset" ? null : "entry-1",
        revisionRef: operation === "remember" || operation === "correct" || operation === "restore"
          ? `revision-${operation}` : null,
        provenanceRef: operation === "remember" || operation === "correct" || operation === "restore"
          ? `provenance-${operation}` : null,
        category: "fact", protectedContent: protectedContent(), expectedRevision: 2,
        expectedEntryVersion: 1n, prioritized: operation === "prioritize",
        restoredFromRevisionRef: operation === "restore" ? "revision-source" : undefined,
        validFrom: null, validTo: null,
        recordedAt: "2026-07-31T12:00:00.000Z",
      } as never);
    }
    const sql = statements.map((item) => item.sql).join("\n");
    for (const operation of operations) {
      expect(sql).toContain(`platform.memory_public_prepare_${operation}`);
      expect(sql).toContain(`platform.memory_public_commit_${operation}`);
    }
    expect(sql).not.toMatch(/platform\.memory_public_authorize_(?:read|command)/u);
  });

  it("rejects unknown decoder fields and accepts canonical null-free command results", async () => {
    rows = [{ result: { spaceRef: "space-user-1", spaceVersion: "7", unexpected: true } }];
    await expect(repository.resolveOwner(lease.transaction, { context,
      operation: "get_entry", candidateSpaceRef: "space-user-1",
      now: "2026-07-31T12:00:00.000Z" })).rejects.toThrow();

    rows = [{ result: { entryRef: "entry-1", entryVersion: "1", category: "fact",
      state: "active", prioritized: false, revision: "1", currentRevisionRef: "revision-1",
      reason: "explicit", validFrom: null, validTo: null,
      createdAt: "2026-07-31T12:00:00+00:00", updatedAt: "2026-07-31T12:00:00+00:00",
      protectedContent: null, sourceKind: "explicit", sourceState: "current",
      safeSourceLabel: "Saved by you", unexpected: true } }];
    await expect(repository.getEntry(lease.transaction, { owner: { context,
      spaceRef: "space-user-1", spaceVersion: 7n }, entryRef: "entry-1" })).rejects.toThrow();
  });

  it("rejects invalid owner persistence metadata", async () => {
    rows = [{ result: { spaceRef: "space-user-1", spaceVersion: "7", persisted: "yes" } }];
    await expect(repository.resolveOwner(lease.transaction, { context,
      operation: "get_entry", candidateSpaceRef: "space-user-1",
      now: "2026-07-31T12:00:00.000Z" })).rejects.toThrow(
      "MEMORY_PERSISTENCE_CONFLICT",
    );
  });

  it("rejects protected content on a revoked tombstone", async () => {
    rows = [{ result: { entryRef: "entry-1", entryVersion: "2", category: "fact",
      state: "revoked_purge_pending", prioritized: false, revision: "1",
      currentRevisionRef: "revision-1", reason: "explicit", validFrom: null, validTo: null,
      createdAt: "2026-07-31T12:00:00+00:00", updatedAt: "2026-07-31T12:00:00+00:00",
      protectedContent: { envelopeVersion: 1, keyRevision: "memory-key-r1",
        nonce: Buffer.alloc(12).toString("base64"), ciphertext: Buffer.from([1]).toString("base64"),
        authenticationTag: Buffer.alloc(16).toString("base64"), aadDigest: "e".repeat(64) },
      sourceKind: "explicit", sourceState: "unavailable", safeSourceLabel: "Removed",
      revokedAt: "2026-07-31T12:00:00+00:00" } }];
    await expect(repository.getEntry(lease.transaction, { owner: { context,
      spaceRef: "space-user-1", spaceVersion: 7n }, entryRef: "entry-1" })).rejects.toThrow(
      "MEMORY_PERSISTENCE_CONFLICT",
    );
  });

  it("normalizes PostgreSQL timestamps and omits absent optional result fields", async () => {
    rows = [{ result: { entryRef: "entry-1", entryVersion: "1", category: "fact",
      state: "active", prioritized: false, revision: "1", currentRevisionRef: "revision-1",
      reason: "explicit", validFrom: null, validTo: null,
      createdAt: "2026-07-31T12:00:00+00:00", updatedAt: "2026-07-31T12:00:00+00:00",
      protectedContent: null, sourceKind: "explicit", sourceState: "current",
      safeSourceLabel: "Saved by you" } }];
    await expect(repository.getEntry(lease.transaction, { owner: { context,
      spaceRef: "space-user-1", spaceVersion: 7n }, entryRef: "entry-1" })).resolves.toMatchObject({
      createdAt: "2026-07-31T12:00:00.000Z", updatedAt: "2026-07-31T12:00:00.000Z",
    });
  });

  it("publishes only operation-specific fixed-search-path routines to the pinned public role", () => {
    const migration = readFileSync(join(process.cwd(),
      "prisma/migrations/20260814_memory_m0_public_owner/migration.sql"), "utf8");
    for (const operation of ["remember", "correct", "restore", "prioritize", "deprioritize",
      "forget", "reset"]) {
      expect(migration).toContain(`CREATE FUNCTION platform.memory_public_prepare_${operation}`);
      expect(migration).toContain(`CREATE FUNCTION platform.memory_public_commit_${operation}`);
    }
    for (const operation of ["list_entries", "get_entry", "list_entry_history",
      "get_restorable_revision"]) {
      expect(migration).toContain(`CREATE FUNCTION platform.memory_public_${operation}`);
    }
    expect(migration).not.toContain("memory_public_authorize_read");
    expect(migration).not.toContain("memory_public_authorize_command");
    expect(migration).not.toContain("current_setting('app.");
    expect(migration).not.toMatch(/GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)[^;]+platform_memory_public/isu);
    expect(migration).toContain("PERFORM platform.assert_memory_database_role('public')");
    expect(migration).toContain("SECURITY DEFINER SET search_path=pg_catalog,platform");
    expect(migration).toContain("release.release_ref=site_owner.active_release_ref");
    expect(migration).toContain("authorization_release.release_ref=release.release_ref");
    expect(migration).toContain("site_owner.tombstoned_at IS NULL");
    expect(migration).toContain("occupied.space_ref=p_candidate_space_ref");
    expect(migration).toContain("CREATE POLICY site_memory_public_definer ON platform.site");
    expect(migration).toContain(
      "CREATE POLICY site_release_memory_public_definer ON platform.site_release",
    );
  });
});

function protectedContent() {
  return createProtectedMemoryContent({ envelopeVersion: 1, keyRevision: "memory-key-r1",
    nonce: new Uint8Array(12), ciphertext: new Uint8Array([1]),
    authenticationTag: new Uint8Array(16), aadDigest: "e".repeat(64) });
}
function spaceState() {
  return { spaceRef: "space-user-1", binding: { kind: "user", siteRef: "site-alpha",
    subjectRef: "subject-alpha", subjectGeneration: "3" },
  featurePolicyRevisionRef: "feature-policy-r7", version: "1", spaceGeneration: "1",
  learningGeneration: "1", revocationEpoch: "1", minimumLearnableSourceOriginSequence: "1",
  learningState: "active", useState: "active", state: "active",
  createdAt: "2026-07-31T11:00:00.000Z", updatedAt: "2026-07-31T11:00:00.000Z" };
}
function entryState() {
  return { siteRef: "site-alpha", spaceRef: "space-user-1", entryRef: "entry-1", version: "1",
    currentRevision: "2", currentRevisionRef: "revision-current", state: "active", category: "fact",
    prioritized: false,
    featurePolicyRevisionRef: "feature-policy-r7", spaceGeneration: "1", learningGeneration: "1",
    revocationEpoch: "1", createdAt: "2026-07-31T11:00:00.000Z",
    updatedAt: "2026-07-31T11:00:00.000Z", deletedAt: null };
}
