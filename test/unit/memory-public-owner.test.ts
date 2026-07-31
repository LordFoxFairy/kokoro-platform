import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MemoryApplicationError,
  MemoryPublicOwner,
  memoryPublicPersonalContext,
  type MemoryContentAdmissionPort,
  type MemoryContentProtectionPort,
  type MemoryPublicCommand,
  type MemoryPublicCommandResult,
  type MemoryPublicRepository,
} from "../../src/modules/memory/index.js";
import { issuePlatformTransaction, revokePlatformTransaction,
  type PlatformTransactionLease } from "../../src/shared/unit-of-work/platform-transaction.js";

const context = memoryPublicPersonalContext({ siteRef: "site-alpha", subjectRef: "subject-alpha",
  subjectGeneration: 3n, featurePolicyRevisionRef: "feature-policy-r7" });

describe("MemoryPublicOwner", () => {
  let lease: PlatformTransactionLease;
  let commands: MemoryPublicCommand[];
  let events: string[];
  let repository: MemoryPublicRepository;
  let recovery: "none" | "replay" | "rotated";

  beforeEach(() => {
    lease = issuePlatformTransaction({ query: async () => [], execute: async () => 0 });
    commands = [];
    events = [];
    recovery = "none";
    repository = {
      recoverCommand: async (_transaction, identity) => {
        events.push(`recover:${identity.requestDigestKeyRevision}`);
        if (recovery === "rotated" && identity.requestDigestKeyRevision !== "memory-command-hmac-r0") {
          return Object.freeze({ kind: "digest_mismatch" as const,
            requestDigestKeyRevision: "memory-command-hmac-r0" });
        }
        if (recovery === "replay" || recovery === "rotated") {
          return Object.freeze({ kind: "replay" as const, result: Object.freeze({
            kind: identity.operation === "restore" ? "restored" as const : "entry" as const,
            entryRef: identity.entryRef, entryVersion: 4n, revision: 3n,
            ...(identity.revisionRef === null ? {} : { revisionRef: identity.revisionRef }),
            ...(identity.operation === "restore"
              ? { restoredFromRevisionRef: "revision-1" } : {}),
            committedSpaceVersion: 9n,
          }) });
        }
        return Object.freeze({ kind: "continue" as const });
      },
      executeCommand: async (_transaction, command) => {
        events.push("persist");
        commands.push(command);
        return Object.freeze({ kind: "entry" as const, entryRef: command.entryRef ?? "entry-1",
          entryVersion: 1n, revision: 1n, revisionRef: command.revisionRef ?? "revision-1",
          committedSpaceVersion: 2n });
      },
      resolveOwner: async () => ({ context, spaceRef: "memory-space:owner", spaceVersion: 7n }),
      listEntries: async () => [],
      getEntry: async () => ({ entryRef: "entry-1", entryVersion: 2n, category: "preference",
        state: "active", prioritized: false, revision: 2n, currentRevisionRef: "revision-2",
        reason: "corrected", validFrom: null, validTo: null,
        createdAt: "2026-07-31T10:00:00.000Z", updatedAt: "2026-07-31T11:00:00.000Z",
        protectedContent: null, sourceKind: "explicit", sourceState: "current",
        safeSourceLabel: "Saved by you" }),
      listHistory: async () => null,
      getRevisionForRestore: async () => ({ revision: 1n, revisionRef: "revision-1",
        reason: "explicit", supersedesRevisionRef: null, restoredFromRevisionRef: null,
        validFrom: null, validTo: null, recordedAt: "2026-07-31T11:00:00.000Z",
        protectedContent: { envelopeVersion: 1, ciphertext: new Uint8Array([1]),
          keyRevision: "key-r1", nonce: new Uint8Array(12),
          authenticationTag: new Uint8Array(16), aadDigest: "a".repeat(64) } as never }),
    };
  });

  afterEach(() => revokePlatformTransaction(lease));

  it("admits ordinary personal content before protection and persists only protected bytes", async () => {
    const owner = createOwner(repository, events, lease);
    const result = await owner.remember({ context, commandRef: "command-remember-1",
      category: "preference", content: "Prefers concise technical answers.",
      validFrom: null, validTo: null });

    expect(events).toEqual(["transaction", "recover:memory-command-hmac-r1", "admit", "protect",
      "transaction", "persist"]);
    expect(result).toMatchObject({ kind: "entry", committedSpaceVersion: 2n });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ operation: "remember", context,
      category: "preference" });
    expect(commands[0]).not.toHaveProperty("content");
    expect(commands[0]).toHaveProperty("protectedContent");
  });

  it("fails closed before encryption for secrets, special-category content, and Project scope", async () => {
    const owner = createOwner(repository, events, lease, {
      admit: async () => { events.push("admit"); return {
        kind: "rejected", reason: "policy_rejected",
      }; },
    });
    await expect(owner.remember({ context, commandRef: "command-secret-1", category: "fact",
      content: "api_key=secret-value", validFrom: null, validTo: null }))
      .rejects.toEqual(new MemoryApplicationError("MEMORY_CONTENT_POLICY_REJECTED"));
    expect(events).toEqual(["transaction", "recover:memory-command-hmac-r1", "admit"]);

    await expect(owner.remember({ context: { ...context, projectRef: "project-alpha" } as never,
      commandRef: "command-project-1", category: "fact", content: "ordinary fact",
      validFrom: null, validTo: null })).rejects.toMatchObject({
      code: "MEMORY_PUBLIC_SCOPE_UNAVAILABLE",
    });
  });

  it("rejects malformed or inverted temporal bounds before admission and protection", async () => {
    const owner = createOwner(repository, events, lease);
    await expect(owner.remember({ context, commandRef: "command-invalid-time-1", category: "fact",
      content: "A bounded fact.", validFrom: "2026-07-31T12:00:00Z", validTo: null }))
      .rejects.toEqual(new MemoryApplicationError("MEMORY_PUBLIC_INPUT_INVALID"));
    await expect(owner.remember({ context, commandRef: "command-invalid-time-2", category: "fact",
      content: "A bounded fact.", validFrom: "2026-07-31T12:00:00.000Z",
      validTo: "2026-07-31T11:59:59.000Z" }))
      .rejects.toEqual(new MemoryApplicationError("MEMORY_PUBLIC_INPUT_INVALID"));
    expect(events).toEqual([]);
  });

  it("returns the exact committed version on keep-first replay and rejects a digest conflict", async () => {
    repository.executeCommand = async (_transaction, command): Promise<MemoryPublicCommandResult> => {
      commands.push(command);
      if (commands.length === 1) return Object.freeze({ kind: "entry", entryRef: command.entryRef!,
        entryVersion: 1n, revision: 1n, revisionRef: command.revisionRef!,
        committedSpaceVersion: 8n });
      if (commands.length === 2) return Object.freeze({ kind: "entry", entryRef: command.entryRef!,
        entryVersion: 1n, revision: 1n, revisionRef: command.revisionRef!,
        committedSpaceVersion: 8n, replayed: true });
      throw new MemoryApplicationError("MEMORY_COMMAND_DIGEST_CONFLICT");
    };
    const owner = createOwner(repository, events, lease);
    const input = { context, commandRef: "command-replay-1", category: "fact" as const,
      content: "The user works in UTC.", validFrom: null, validTo: null };
    const first = await owner.remember(input);
    const replay = await owner.remember(input);
    expect(first.committedSpaceVersion).toBe(8n);
    expect(replay).toMatchObject({ committedSpaceVersion: 8n, replayed: true });
    await expect(owner.remember({ ...input, content: "The user works in UTC+1." }))
      .rejects.toEqual(new MemoryApplicationError("MEMORY_COMMAND_DIGEST_CONFLICT"));
  });

  it("replays before mutable admission, reads, decrypt, or encryption and uses the original key revision", async () => {
    recovery = "rotated";
    const owner = createOwner(repository, events, lease);
    const replay = await owner.correct({ context, commandRef: "command-replay-rotated",
      entryRef: "entry-1", expectedRevision: 2, content: "replacement",
      validFrom: null, validTo: null });
    expect(replay).toMatchObject({ replayed: true, committedSpaceVersion: 9n });
    expect(events).toEqual(["transaction", "recover:memory-command-hmac-r1",
      "transaction", "recover:memory-command-hmac-r0"]);
    expect(commands).toEqual([]);
  });

  it("routes restore, priority, forget, and reset through closed personal commands", async () => {
    const owner = createOwner(repository, events, lease);
    await owner.restore({ context, commandRef: "command-restore-1", entryRef: "entry-1",
      revisionRef: "revision-1", expectedRevision: 2 });
    await owner.setPriority({ context, commandRef: "command-priority-1", entryRef: "entry-1",
      expectedEntryVersion: 2n, prioritized: true });
    await owner.forget({ context, commandRef: "command-forget-1", entryRef: "entry-1",
      expectedEntryVersion: 3n });
    await owner.reset({ context, commandRef: "command-reset-1" });
    expect(commands.map(({ operation }) => operation)).toEqual([
      "restore", "prioritize", "forget", "reset",
    ]);
  });
});

function createOwner(repository: MemoryPublicRepository, events: string[], lease: PlatformTransactionLease,
  admissionOverride?: Partial<MemoryContentAdmissionPort>) {
  const admission: MemoryContentAdmissionPort = {
    admit: async () => { events.push("admit"); return { kind: "accepted" }; },
    ...admissionOverride,
  };
  const protector: MemoryContentProtectionPort = {
    protect: async () => { events.push("protect"); return {
      envelopeVersion: 1, ciphertext: new Uint8Array([1]), keyRevision: "key-r1",
      nonce: new Uint8Array(12), authenticationTag: new Uint8Array(16), aadDigest: "a".repeat(64),
    } as never; },
    reveal: async () => new TextEncoder().encode("restored content"),
  };
  return new MemoryPublicOwner({ admission, protector, repository,
    fingerprints: { fingerprint: async (_input, keyRevision) => ({
      keyRevision: keyRevision ?? "memory-command-hmac-r1", digest: "b".repeat(64),
    }) },
    unitOfWork: { execute: async (_fence, work) => {
      events.push("transaction"); return work(lease.transaction);
    } }, clock: () => new Date("2026-07-31T12:00:00.000Z") });
}
