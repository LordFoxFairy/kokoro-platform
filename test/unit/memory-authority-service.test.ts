import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MemoryApplicationError,
  MemoryAuthorityService,
  createMemorySpace,
  createProtectedMemoryContent,
  memoryFeaturePolicyRevisionRef,
  memoryBindingSiteRef,
  rehydrateMemoryActorAuthorization,
  resetMemorySpace,
  type MemoryAuthorizationFactsPort,
  type MemoryAuthorizationFactsResult,
  type MemoryAuthorityRepository,
  type MemoryCommandReceiptIdentity,
  type MemoryCommandResult,
  type MemoryEntry,
  type MemoryProvenance,
  type MemoryReceiptClaim,
  type MemoryRevision,
  type MemorySpace,
  type RememberedMemory,
} from "../../src/modules/memory/index.js";
import { issuePlatformTransaction, revokePlatformTransaction,
  type PlatformTransactionLease } from "../../src/shared/unit-of-work/platform-transaction.js";

const protectedEnvelope = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  envelopeVersion: 1,
  ciphertext: new Uint8Array([1, 2, 3]),
  keyRevision: "memory-key-r2",
  nonce: new Uint8Array(12).fill(1),
  authenticationTag: new Uint8Array(16).fill(2),
  aadDigest: "a".repeat(64),
  ...overrides,
});
const protectedContent = () => createProtectedMemoryContent(protectedEnvelope());

const userBinding = Object.freeze({
  kind: "user" as const,
  siteRef: "site-alpha",
  subjectRef: "subject-alpha",
  subjectGeneration: 3n,
});

const projectBinding = Object.freeze({
  kind: "project" as const,
  siteRef: "site-alpha",
  projectRef: "project-alpha",
});

const projectMember = rehydrateMemoryActorAuthorization({
  kind: "project_member" as const,
  siteRef: "site-alpha",
  projectRef: "project-alpha",
  subjectRef: "subject-alpha",
  subjectGeneration: 3n,
  membershipEpoch: 4n,
  authorizationEpoch: 5n,
});

function rememberCommand(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    commandRef: "command-remember-1",
    binding: userBinding,
    spaceRef: "space-user-1",
    expectedSpaceVersion: 0n,
    entryRef: "memory-entry-1",
    revisionRef: "memory-revision-1",
    provenanceRef: "memory-provenance-1",
    sourceDigest: "c".repeat(64),
    protectedContent: protectedContent(),
    category: "preference" as const,
    featurePolicyRevisionRef: "feature-policy-r7",
    recordedAt: "2026-07-30T12:00:00.000Z",
    ...overrides,
  };
}

class FakeAuthorizationFacts implements MemoryAuthorizationFactsPort {
  calls = 0;
  result: MemoryAuthorizationFactsResult | null = null;

  async revalidate(_transaction: Parameters<MemoryAuthorizationFactsPort["revalidate"]>[0],
    expected: Parameters<MemoryAuthorizationFactsPort["revalidate"]>[1]):
    Promise<MemoryAuthorizationFactsResult> {
    this.calls += 1;
    const base = expected.binding.kind === "agent_product"
      ? expected.binding.parentBinding : expected.binding;
    const actorAuthorization = base.kind === "user" ? base : projectMember;
    return this.result ?? { kind: "authorized", actorAuthorization,
      featurePolicyRevisionRef: expected.featurePolicyRevisionRef };
  }
}

class FakeMemoryRepository implements MemoryAuthorityRepository {
  readonly spaces = new Map<string, MemorySpace>();
  readonly entries = new Map<string, MemoryEntry>();
  readonly revisions: MemoryRevision[] = [];
  readonly provenances: MemoryProvenance[] = [];
  readonly receipts = new Map<string, Readonly<{ digest: string; result: MemoryCommandResult }>>();
  mutationCount = 0;
  async loadSpaceAuthorityForUpdate(transaction: Parameters<MemoryAuthorityRepository["loadSpaceAuthorityForUpdate"]>[0],
    siteRef: Parameters<MemoryAuthorityRepository["loadSpaceAuthorityForUpdate"]>[1],
    spaceRef: Parameters<MemoryAuthorityRepository["loadSpaceAuthorityForUpdate"]>[2],
    expectedParentSpaceRef?: Parameters<MemoryAuthorityRepository["loadSpaceAuthorityForUpdate"]>[3]) {
    const space = await this.loadSpaceForUpdate(transaction, siteRef, spaceRef);
    const parentRef = space?.binding.kind === "agent_product" ? space.binding.parentSpaceRef
      : expectedParentSpaceRef;
    const parent = parentRef === undefined ? null
      : await this.loadSpaceForUpdate(transaction, siteRef, parentRef);
    return Object.freeze({ space, parent });
  }

  async loadSpaceForUpdate(_transaction: Parameters<MemoryAuthorityRepository["loadSpaceForUpdate"]>[0],
    siteRef: Parameters<MemoryAuthorityRepository["loadSpaceForUpdate"]>[1],
    spaceRef: Parameters<MemoryAuthorityRepository["loadSpaceForUpdate"]>[2]): Promise<MemorySpace | null> {
    return this.spaces.get(`${siteRef}:${spaceRef}`) ?? null;
  }

  async loadEntryForUpdate(_transaction: Parameters<MemoryAuthorityRepository["loadEntryForUpdate"]>[0],
    siteRef: Parameters<MemoryAuthorityRepository["loadEntryForUpdate"]>[1],
    spaceRef: Parameters<MemoryAuthorityRepository["loadEntryForUpdate"]>[2],
    entryRef: Parameters<MemoryAuthorityRepository["loadEntryForUpdate"]>[3]): Promise<MemoryEntry | null> {
    return this.entries.get(`${siteRef}:${spaceRef}:${entryRef}`) ?? null;
  }

  async claimReceipt(_transaction: Parameters<MemoryAuthorityRepository["claimReceipt"]>[0],
    identity: MemoryCommandReceiptIdentity): Promise<MemoryReceiptClaim> {
    const key = receiptKey(identity);
    const existing = this.receipts.get(key);
    if (existing === undefined) return { kind: "claimed" };
    if (existing.digest !== identity.requestDigest) return { kind: "digest_conflict" };
    return { kind: "replay", result: existing.result };
  }

  async completeReceipt(_transaction: Parameters<MemoryAuthorityRepository["completeReceipt"]>[0],
    identity: MemoryCommandReceiptIdentity, result: MemoryCommandResult): Promise<void> {
    this.receipts.set(receiptKey(identity), { digest: identity.requestDigest, result });
  }

  async saveRememberedMemory(_transaction: Parameters<MemoryAuthorityRepository["saveRememberedMemory"]>[0],
    newSpace: MemorySpace | null, remembered: RememberedMemory): Promise<void> {
    this.mutationCount += 1;
    if (newSpace !== null) this.spaces.set(`${remembered.entry.siteRef}:${newSpace.spaceRef}`, newSpace);
    this.entries.set(`${remembered.entry.siteRef}:${remembered.entry.spaceRef}:${remembered.entry.entryRef}`,
      remembered.entry);
    this.revisions.push(remembered.revision);
    this.provenances.push(remembered.provenance);
  }

  async saveCorrectedMemory(_transaction: Parameters<MemoryAuthorityRepository["saveCorrectedMemory"]>[0],
    expected: Parameters<MemoryAuthorityRepository["saveCorrectedMemory"]>[1],
    remembered: RememberedMemory): Promise<void> {
    const key = `${remembered.entry.siteRef}:${remembered.entry.spaceRef}:${remembered.entry.entryRef}`;
    const current = this.entries.get(key);
    if (current?.version !== expected.entryVersion ||
      current.currentRevision !== expected.currentRevision) throw new Error("fake CAS failed");
    this.mutationCount += 1;
    this.entries.set(key, remembered.entry);
    this.revisions.push(remembered.revision);
    this.provenances.push(remembered.provenance);
  }

  async saveForgottenMemory(_transaction: Parameters<MemoryAuthorityRepository["saveForgottenMemory"]>[0],
    expected: Parameters<MemoryAuthorityRepository["saveForgottenMemory"]>[1],
    space: MemorySpace, entry: MemoryEntry): Promise<void> {
    const spaceKey = `${entry.siteRef}:${space.spaceRef}`;
    const entryKey = `${entry.siteRef}:${entry.spaceRef}:${entry.entryRef}`;
    if (this.spaces.get(spaceKey)?.version !== expected.spaceVersion ||
      this.entries.get(entryKey)?.version !== expected.entryVersion) throw new Error("fake CAS failed");
    this.mutationCount += 1;
    this.spaces.set(spaceKey, space);
    this.entries.set(entryKey, entry);
  }

  async saveSpace(_transaction: Parameters<MemoryAuthorityRepository["saveSpace"]>[0],
    expectedVersion: Parameters<MemoryAuthorityRepository["saveSpace"]>[1],
    space: MemorySpace): Promise<void> {
    const key = `${space.binding.kind === "agent_product"
      ? space.binding.parentBinding.siteRef : space.binding.siteRef}:${space.spaceRef}`;
    if (this.spaces.get(key)?.version !== expectedVersion) throw new Error("fake CAS failed");
    this.mutationCount += 1;
    this.spaces.set(key, space);
  }

  async saveReboundPolicy(_transaction: Parameters<MemoryAuthorityRepository["saveReboundPolicy"]>[0],
    _expected: Parameters<MemoryAuthorityRepository["saveReboundPolicy"]>[1], space: MemorySpace) {
    this.spaces.set(`${memoryBindingSiteRef(space.binding)}:${space.spaceRef}`, space);
    this.mutationCount += 1;
  }
}

function receiptKey(identity: MemoryCommandReceiptIdentity): string {
  const owner = identity.owner.kind === "user"
    ? `${identity.owner.siteRef}:user:${identity.owner.subjectRef}:${identity.owner.subjectGeneration}`
    : `${identity.owner.siteRef}:project:${identity.owner.projectRef}`;
  return `${owner}:${identity.commandRef}`;
}

describe("MemoryAuthorityService", () => {
  let lease: PlatformTransactionLease;
  let repository: FakeMemoryRepository;
  let authorization: FakeAuthorizationFacts;
  let service: MemoryAuthorityService;

  beforeEach(() => {
    lease = issuePlatformTransaction({ query: async () => [], execute: async () => 0 });
    repository = new FakeMemoryRepository();
    authorization = new FakeAuthorizationFacts();
    service = new MemoryAuthorityService(repository, authorization);
  });

  afterEach(() => revokePlatformTransaction(lease));

  it("revalidates owner facts and replays the exact remembered result without repeating writes", async () => {
    const first = await service.remember(lease.transaction, rememberCommand());
    const replay = await service.remember(lease.transaction, rememberCommand());

    expect(first).toEqual(replay);
    expect(first).toMatchObject({ kind: "remembered", spaceRef: "space-user-1",
      spaceVersion: 1n, entryRef: "memory-entry-1", entryVersion: 1n,
      revisionRef: "memory-revision-1", revision: 1n });
    expect(repository.mutationCount).toBe(1);
    expect(repository.revisions).toHaveLength(1);
    expect(authorization.calls).toBe(2);
    expect(Object.keys(first).sort()).toEqual([
      "entryRef", "entryVersion", "kind", "revision", "revisionRef", "spaceRef", "spaceVersion",
    ]);
  });

  it("derives the receipt digest from canonical payload fields instead of caller input", async () => {
    const command = rememberCommand({
      commandRef: "command-canonical-remember",
    });
    const first = await service.remember(lease.transaction, command);
    const { category, ...remainingCommand } = command;
    const reordered = { category, ...remainingCommand };
    await expect(service.remember(lease.transaction, reordered)).resolves.toEqual(first);
    await expect(service.remember(lease.transaction, { ...command, category: "fact" }))
      .rejects.toEqual(new MemoryApplicationError("MEMORY_COMMAND_DIGEST_CONFLICT"));
    const protectedMutations = [
      createProtectedMemoryContent(protectedEnvelope({ ciphertext: new Uint8Array([9, 2, 3]) })),
      createProtectedMemoryContent(protectedEnvelope({ ciphertext: new Uint8Array([1, 2, 3, 4]) })),
      createProtectedMemoryContent(protectedEnvelope({ keyRevision: "memory-key-r3" })),
      createProtectedMemoryContent(protectedEnvelope({ aadDigest: "c".repeat(64) })),
      createProtectedMemoryContent(protectedEnvelope({ nonce: new Uint8Array(12).fill(3) })),
      createProtectedMemoryContent(protectedEnvelope({
        authenticationTag: new Uint8Array(16).fill(3),
      })),
    ];
    for (const protectedContentMutation of protectedMutations) {
      await expect(service.remember(lease.transaction,
        { ...command, protectedContent: protectedContentMutation })).rejects.toEqual(
        new MemoryApplicationError("MEMORY_COMMAND_DIGEST_CONFLICT"),
      );
    }
    await expect(service.remember(lease.transaction,
      { ...command, requestDigest: "0".repeat(64) })).rejects.toMatchObject({
      code: "MEMORY_ENTRY_INVALID",
    });
  });

  it("rejects a changed canonical payload under the same owner command identity before mutation", async () => {
    await service.remember(lease.transaction, rememberCommand());
    const error = await service.remember(lease.transaction,
      rememberCommand({ category: "fact" })).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(MemoryApplicationError);
    expect(error).toMatchObject({ code: "MEMORY_COMMAND_DIGEST_CONFLICT" });
    expect(repository.mutationCount).toBe(1);
  });

  it("fails closed on a malformed authorization result before any authority mutation", async () => {
    authorization.result = { kind: "authorized", actorAuthorization: userBinding,
      featurePolicyRevisionRef: "feature-policy-r7", unexpected: true } as unknown as
      MemoryAuthorizationFactsResult;
    await expect(service.remember(lease.transaction, rememberCommand())).rejects.toEqual(
      new MemoryApplicationError("MEMORY_AUTHORIZATION_FACTS_STALE"),
    );
    expect(repository.mutationCount).toBe(0);
  });

  it("rejects cross-operation receipt replay even when the owner command digest matches", async () => {
    await service.remember(lease.transaction, rememberCommand());
    await expect(service.pauseLearning(lease.transaction, {
      commandRef: "command-remember-1",
      siteRef: "site-alpha", spaceRef: "space-user-1", expectedSpaceVersion: 1n,
      featurePolicyRevisionRef: "feature-policy-r7", recordedAt: "2026-07-30T12:01:00.000Z",
    })).rejects.toEqual(new MemoryApplicationError("MEMORY_COMMAND_DIGEST_CONFLICT"));
    expect(repository.mutationCount).toBe(1);
  });

  it("appends a correction and then forgets without rewriting revision history", async () => {
    await service.remember(lease.transaction, rememberCommand());
    const correctCommand = {
      commandRef: "command-correct-1",
      siteRef: "site-alpha", spaceRef: "space-user-1", expectedSpaceVersion: 1n,
      entryRef: "memory-entry-1", expectedEntryVersion: 1n, expectedCurrentRevision: 1n,
      revisionRef: "memory-revision-2", provenanceRef: "memory-provenance-2",
      sourceDigest: "e".repeat(64), protectedContent: protectedContent(),
      featurePolicyRevisionRef: "feature-policy-r7", recordedAt: "2026-07-30T12:01:00.000Z",
    };
    const corrected = await service.correct(lease.transaction, correctCommand);
    await expect(service.correct(lease.transaction, correctCommand)).resolves.toEqual(corrected);
    await expect(service.correct(lease.transaction,
      { ...correctCommand, sourceDigest: "7".repeat(64) })).rejects.toEqual(
      new MemoryApplicationError("MEMORY_COMMAND_DIGEST_CONFLICT"),
    );
    expect(corrected).toMatchObject({ kind: "corrected", entryVersion: 2n, revision: 2n });
    expect(repository.revisions.map((revision) => revision.reason)).toEqual(["explicit", "corrected"]);

    const forgetCommand = {
      commandRef: "command-forget-1",
      siteRef: "site-alpha", spaceRef: "space-user-1", expectedSpaceVersion: 1n,
      entryRef: "memory-entry-1", expectedEntryVersion: 2n,
      featurePolicyRevisionRef: "feature-policy-r7", recordedAt: "2026-07-30T12:02:00.000Z",
    };
    const forgotten = await service.forget(lease.transaction, forgetCommand);
    await expect(service.forget(lease.transaction, forgetCommand)).resolves.toEqual(forgotten);
    await expect(service.forget(lease.transaction,
      { ...forgetCommand, recordedAt: "2026-07-30T12:03:00.000Z" })).rejects.toEqual(
      new MemoryApplicationError("MEMORY_COMMAND_DIGEST_CONFLICT"),
    );
    expect(forgotten).toMatchObject({ kind: "forgotten", spaceVersion: 2n,
      entryVersion: 3n, revocationEpoch: 2n });
    expect(repository.revisions).toHaveLength(2);
    expect(repository.entries.get("site-alpha:space-user-1:memory-entry-1"))
      .toMatchObject({ state: "deleted", currentRevision: 2n });
  });

  it("rejects a correction replay once reset makes the entry fence stale", async () => {
    await service.remember(lease.transaction, rememberCommand());
    const command = { commandRef: "command-correct-stale",
      siteRef: "site-alpha", spaceRef: "space-user-1", expectedSpaceVersion: 1n,
      entryRef: "memory-entry-1", expectedEntryVersion: 1n, expectedCurrentRevision: 1n,
      revisionRef: "memory-revision-stale-2", provenanceRef: "memory-provenance-stale-2",
      sourceDigest: "3".repeat(64), protectedContent: protectedContent(),
      featurePolicyRevisionRef: "feature-policy-r7", recordedAt: "2026-07-30T12:01:00.000Z" };
    await service.correct(lease.transaction, command);
    const space = repository.spaces.get("site-alpha:space-user-1");
    if (space === undefined) throw new Error("missing fake space");
    repository.spaces.set("site-alpha:space-user-1", resetMemorySpace({ space,
      expectedVersion: space.version, resetCutoffOriginSequence: 70n,
      changedAt: "2026-07-30T12:02:00.000Z" }));

    await expect(service.correct(lease.transaction, command)).rejects.toMatchObject({
      code: "MEMORY_ENTRY_FENCE_CONFLICT",
    });
  });

  it("keeps Project memory shared while recording each current member in provenance", async () => {
    await service.remember(lease.transaction, rememberCommand({
      binding: projectBinding, spaceRef: "space-project-1",
    }));
    expect(repository.provenances[0]).toMatchObject({ actorSubjectRef: "subject-alpha",
      actorProjectRef: "project-alpha", actorMembershipEpoch: 4n, actorAuthorizationEpoch: 5n });

    authorization.result = { kind: "authorized", actorAuthorization:
      rehydrateMemoryActorAuthorization({
      ...projectMember, subjectRef: "subject-beta", subjectGeneration: 8n,
      membershipEpoch: 9n, authorizationEpoch: 10n,
      }), featurePolicyRevisionRef: memoryFeaturePolicyRevisionRef("feature-policy-r7") };
    await service.correct(lease.transaction, {
      commandRef: "command-project-correct",
      siteRef: "site-alpha", spaceRef: "space-project-1", expectedSpaceVersion: 1n,
      entryRef: "memory-entry-1", expectedEntryVersion: 1n, expectedCurrentRevision: 1n,
      revisionRef: "memory-revision-project-2", provenanceRef: "memory-provenance-project-2",
      sourceDigest: "8".repeat(64), protectedContent: protectedContent(),
      featurePolicyRevisionRef: "feature-policy-r7", recordedAt: "2026-07-30T12:01:00.000Z",
    });
    expect(repository.provenances[1]).toMatchObject({ actorSubjectRef: "subject-beta",
      actorSubjectGeneration: 8n, actorProjectRef: "project-alpha",
      actorMembershipEpoch: 9n, actorAuthorizationEpoch: 10n });
    expect(repository.spaces.get("site-alpha:space-project-1")?.binding).toEqual(projectBinding);
  });

  it("replays controls exactly once while preserving monotonic generations and epochs", async () => {
    repository.spaces.set("site-alpha:space-user-1", createMemorySpace({
      spaceRef: "space-user-1", binding: userBinding,
      featurePolicyRevisionRef: "feature-policy-r7", recordedAt: "2026-07-30T12:00:00.000Z",
    }));
    const paused = await service.pauseLearning(lease.transaction, {
      commandRef: "command-pause-learning-1",
      siteRef: "site-alpha", spaceRef: "space-user-1", expectedSpaceVersion: 1n,
      featurePolicyRevisionRef: "feature-policy-r7", recordedAt: "2026-07-30T12:01:00.000Z",
    });
    const replay = await service.pauseLearning(lease.transaction, {
      commandRef: "command-pause-learning-1",
      siteRef: "site-alpha", spaceRef: "space-user-1", expectedSpaceVersion: 1n,
      featurePolicyRevisionRef: "feature-policy-r7", recordedAt: "2026-07-30T12:01:00.000Z",
    });
    expect(replay).toEqual(paused);
    await expect(service.pauseLearning(lease.transaction, {
      commandRef: "command-pause-learning-1", siteRef: "site-alpha", spaceRef: "space-user-1",
      expectedSpaceVersion: 1n, featurePolicyRevisionRef: "feature-policy-r7",
      recordedAt: "2026-07-30T12:01:01.000Z",
    })).rejects.toEqual(new MemoryApplicationError("MEMORY_COMMAND_DIGEST_CONFLICT"));
    expect(repository.mutationCount).toBe(1);

    const resumed = await service.resumeLearning(lease.transaction, {
      commandRef: "command-resume-learning-1",
      siteRef: "site-alpha", spaceRef: "space-user-1", expectedSpaceVersion: 2n,
      featurePolicyRevisionRef: "feature-policy-r7", cutoffOriginSequence: 10n,
      recordedAt: "2026-07-30T12:02:00.000Z",
    });
    const reset = await service.reset(lease.transaction, {
      commandRef: "command-reset-1",
      siteRef: "site-alpha", spaceRef: "space-user-1", expectedSpaceVersion: 3n,
      featurePolicyRevisionRef: "feature-policy-r7", cutoffOriginSequence: 20n,
      recordedAt: "2026-07-30T12:03:00.000Z",
    });
    expect(resumed).toMatchObject({ kind: "learning_resumed", learningGeneration: 3n,
      minimumLearnableSourceOriginSequence: 11n });
    expect(reset).toMatchObject({ kind: "reset", spaceGeneration: 2n,
      learningGeneration: 4n, revocationEpoch: 2n,
      minimumLearnableSourceOriginSequence: 21n });
  });

  it.each([
    ["cross Site", userBinding,
      rehydrateMemoryActorAuthorization({ ...userBinding, siteRef: "site-other" })],
    ["subject generation", userBinding,
      rehydrateMemoryActorAuthorization({ ...userBinding, subjectGeneration: 4n })],
    ["cross Project", projectBinding,
      rehydrateMemoryActorAuthorization({ ...projectMember, projectRef: "project-other" })],
  ])("fails closed on stale %s authorization facts", async (_label, binding, actorAuthorization) => {
    const command = rememberCommand({ binding });
    authorization.result = {
      kind: "authorized",
      actorAuthorization,
      featurePolicyRevisionRef: memoryFeaturePolicyRevisionRef("feature-policy-r7"),
    };
    await expect(service.remember(lease.transaction, command)).rejects.toMatchObject({
      code: "MEMORY_AUTHORIZATION_FACTS_STALE",
    });
    expect(repository.mutationCount).toBe(0);
  });

  it.each(["membership_epoch_mismatch", "authorization_epoch_mismatch"] as const)(
    "fails closed when current Project membership authority reports %s",
    async (reason) => {
      authorization.result = { kind: "denied", reason };
      await expect(service.remember(lease.transaction,
        rememberCommand({ binding: projectBinding }))).rejects.toMatchObject({
        code: "MEMORY_AUTHORIZATION_DENIED",
      });
      expect(repository.mutationCount).toBe(0);
    },
  );

  it("rejects agent/product creation when the database parent does not match its frozen bucket", async () => {
    repository.spaces.set("site-alpha:parent-space", createMemorySpace({
      spaceRef: "parent-space",
      binding: { ...userBinding, subjectRef: "subject-other" },
      featurePolicyRevisionRef: "feature-policy-r7", recordedAt: "2026-07-30T12:00:00.000Z",
    }));
    await expect(service.remember(lease.transaction, rememberCommand({
      binding: { kind: "agent_product", parentSpaceRef: "parent-space", parentBinding: userBinding,
        parentSpaceGeneration: 1n, parentLearningGeneration: 1n, parentRevocationEpoch: 1n,
        agentOptionRef: "agent-option-1", productSurfaceRef: "chat" },
      spaceRef: "agent-product-space",
    }))).rejects.toMatchObject({ code: "MEMORY_PARENT_SCOPE_INVALID" });
    expect(repository.mutationCount).toBe(0);
  });

  it("rejects every old child command after the frozen parent fence advances", async () => {
    const parent = createMemorySpace({ spaceRef: "parent-current", binding: userBinding,
      featurePolicyRevisionRef: "feature-policy-r7", recordedAt: "2026-07-30T12:00:00.000Z" });
    repository.spaces.set("site-alpha:parent-current", parent);
    const binding = { kind: "agent_product" as const, parentSpaceRef: parent.spaceRef,
      parentBinding: userBinding, parentSpaceGeneration: parent.spaceGeneration,
      parentLearningGeneration: parent.learningGeneration, parentRevocationEpoch: parent.revocationEpoch,
      agentOptionRef: "agent-option-1", productSurfaceRef: "chat" };
    const childCommand = rememberCommand({ binding, spaceRef: "agent-child-current" });
    await service.remember(lease.transaction, childCommand);
    repository.spaces.set("site-alpha:parent-current", resetMemorySpace({ space: parent,
      expectedVersion: parent.version, resetCutoffOriginSequence: 50n,
      changedAt: "2026-07-30T12:02:00.000Z" }));

    await expect(service.pauseUse(lease.transaction, { commandRef: "command-child-pause",
      siteRef: "site-alpha", spaceRef: "agent-child-current",
      expectedSpaceVersion: 1n, featurePolicyRevisionRef: "feature-policy-r7",
      recordedAt: "2026-07-30T12:03:00.000Z" })).rejects.toMatchObject({
      code: "MEMORY_PARENT_SCOPE_INVALID",
    });
    await expect(service.remember(lease.transaction, childCommand)).rejects.toMatchObject({
      code: "MEMORY_PARENT_SCOPE_INVALID",
    });
  });

  it("rebinds feature policy under owner CAS and replays the closed receipt", async () => {
    const initial = createMemorySpace({ spaceRef: "space-user-policy", binding: userBinding,
      featurePolicyRevisionRef: "feature-policy-r7", recordedAt: "2026-07-30T12:00:00.000Z" });
    repository.spaces.set("site-alpha:space-user-policy", initial);
    const command = { commandRef: "command-policy-1",
      siteRef: "site-alpha", spaceRef: "space-user-policy", expectedSpaceVersion: 1n,
      expectedFeaturePolicyRevisionRef: "feature-policy-r7",
      nextFeaturePolicyRevisionRef: "feature-policy-r8", cutoffOriginSequence: 40n,
      recordedAt: "2026-07-30T12:01:00.000Z" };

    const first = await service.rebindFeaturePolicy(lease.transaction, command);
    const replay = await service.rebindFeaturePolicy(lease.transaction, command);

    expect(first).toEqual(replay);
    expect(first).toMatchObject({ kind: "policy_rebound", spaceVersion: 2n,
      previousFeaturePolicyRevisionRef: "feature-policy-r7",
      featurePolicyRevisionRef: "feature-policy-r8", spaceGeneration: 2n,
      learningGeneration: 2n, revocationEpoch: 2n, learningState: "paused", useState: "paused" });
    expect(repository.mutationCount).toBe(1);
    await expect(service.rebindFeaturePolicy(lease.transaction,
      { ...command, cutoffOriginSequence: 41n })).rejects.toEqual(
      new MemoryApplicationError("MEMORY_COMMAND_DIGEST_CONFLICT"),
    );
    if (first.kind !== "policy_rebound") throw new Error("unexpected result kind");
    const stored = [...repository.receipts.entries()][0];
    if (stored === undefined) throw new Error("missing fake receipt");
    repository.receipts.set(stored[0], { digest: stored[1].digest,
      result: { ...first, previousFeaturePolicyRevisionRef: first.featurePolicyRevisionRef } });
    await expect(service.rebindFeaturePolicy(lease.transaction, command)).rejects.toEqual(
      new MemoryApplicationError("MEMORY_RECEIPT_INVALID"),
    );
  });

  it("rejects an independent child policy rebind in the parent-bound M0 model", async () => {
    const parent = createMemorySpace({ spaceRef: "parent-policy", binding: userBinding,
      featurePolicyRevisionRef: "feature-policy-r7", recordedAt: "2026-07-30T12:00:00.000Z" });
    repository.spaces.set("site-alpha:parent-policy", parent);
    const binding = { kind: "agent_product" as const, parentSpaceRef: parent.spaceRef,
      parentBinding: userBinding, parentSpaceGeneration: parent.spaceGeneration,
      parentLearningGeneration: parent.learningGeneration, parentRevocationEpoch: parent.revocationEpoch,
      agentOptionRef: "agent-option-policy", productSurfaceRef: "chat" };
    await service.remember(lease.transaction, rememberCommand({ binding,
      spaceRef: "agent-child-policy", commandRef: "command-child-create" }));

    await expect(service.rebindFeaturePolicy(lease.transaction, { commandRef: "command-child-policy",
      siteRef: "site-alpha", spaceRef: "agent-child-policy",
      expectedSpaceVersion: 1n, expectedFeaturePolicyRevisionRef: "feature-policy-r7",
      nextFeaturePolicyRevisionRef: "feature-policy-r8", cutoffOriginSequence: 60n,
      recordedAt: "2026-07-30T12:04:00.000Z" })).rejects.toMatchObject({
      code: "MEMORY_PARENT_SCOPE_INVALID",
    });
    expect(repository.mutationCount).toBe(1);
  });
});
