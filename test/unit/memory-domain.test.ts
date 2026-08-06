import { describe, expect, it } from "vitest";
import * as protectedContentModule from
  "../../src/modules/memory/domain/protected-memory-content.js";
import {
  MemoryDomainError,
  correctMemoryEntry,
  createAgentProductMemorySpace,
  createMemorySpace,
  createProtectedMemoryContent,
  createRememberedMemory,
  forgetMemoryEntry,
  memorySpaceRef,
  pauseMemoryLearning,
  pauseMemoryUse,
  rehydrateMemorySpace,
  rebindMemoryFeaturePolicy,
  resetMemorySpace,
  resumeMemoryLearning,
  resumeMemoryUse,
} from "../../src/modules/memory/index.js";

const maximumInt8 = 9_223_372_036_854_775_807n;

function userSpace() {
  return createMemorySpace({
    spaceRef: "space-user-1",
    binding: {
      kind: "user",
      siteRef: "site-alpha",
      subjectRef: "subject-alpha",
      subjectGeneration: 3n,
    },
    featurePolicyRevisionRef: "feature-policy-r7",
    recordedAt: "2026-07-30T12:00:00.000Z",
  });
}

function protectedContent(bytes: readonly number[] = [1, 2, 3]) {
  return createProtectedMemoryContent({
    envelopeVersion: 1, ciphertext: new Uint8Array(bytes),
    keyRevision: "memory-key-r2",
    nonce: new Uint8Array(12).fill(1), authenticationTag: new Uint8Array(16).fill(2),
    aadDigest: "a".repeat(64),
  });
}

const userActorAuthorization = Object.freeze({ kind: "user" as const, siteRef: "site-alpha",
  subjectRef: "subject-alpha", subjectGeneration: 3n });

describe("Memory M0 domain runtime boundary", () => {
  it("accepts only exact plain records and snapshots an accessor once", () => {
    let reads = 0;
    const raw = {
      get spaceRef() {
        reads += 1;
        return "space-user-1";
      },
      binding: {
        kind: "user",
        siteRef: "site-alpha",
        subjectRef: "subject-alpha",
        subjectGeneration: 3n,
      },
      featurePolicyRevisionRef: "feature-policy-r7",
      version: 1n,
      spaceGeneration: 1n,
      learningGeneration: 1n,
      revocationEpoch: 1n,
      minimumLearnableSourceOriginSequence: 1n,
      learningState: "active",
      useState: "active",
      state: "active",
      createdAt: "2026-07-30T12:00:00.000Z",
      updatedAt: "2026-07-30T12:00:00.000Z",
    };

    expect(rehydrateMemorySpace(raw).spaceRef).toBe("space-user-1");
    expect(reads).toBe(1);
    expect(() => rehydrateMemorySpace({ ...raw, workspaceRef: "not-a-memory-scope" }))
      .toThrowError(MemoryDomainError);
    expect(() => rehydrateMemorySpace(Object.assign(Object.create({}), raw)))
      .toThrowError(MemoryDomainError);

    let scopeKindReads = 0;
    const accessorBinding = Object.defineProperties({}, {
      kind: { enumerable: true, get: () => { scopeKindReads += 1; return "user"; } },
      siteRef: { enumerable: true, value: "site-alpha" },
      subjectRef: { enumerable: true, value: "subject-alpha" },
      subjectGeneration: { enumerable: true, value: 3n },
    });
    expect(createMemorySpace({ spaceRef: "space-accessor", binding: accessorBinding,
      featurePolicyRevisionRef: "feature-policy-r7",
      recordedAt: "2026-07-30T12:00:00.000Z" }).binding.kind).toBe("user");
    expect(scopeKindReads).toBe(1);
  });

  it("rejects malformed UTF-16 and signed-int8 overflow at runtime", () => {
    expect(() => memorySpaceRef("broken-\ud800")).toThrowError(
      expect.objectContaining({ code: "MEMORY_REFERENCE_INVALID" }),
    );
    expect(() => rehydrateMemorySpace({ ...userSpace(), version: maximumInt8 + 1n }))
      .toThrowError(expect.objectContaining({ code: "MEMORY_INT8_INVALID" }));
    expect(() => rehydrateMemorySpace({ ...userSpace(), version: 1 }))
      .toThrowError(expect.objectContaining({ code: "MEMORY_INT8_INVALID" }));
  });

  it("closes scope kinds and makes agent/product scope a child narrowing of one base bucket", () => {
    const project = createMemorySpace({
      spaceRef: "space-project-1",
      binding: {
        kind: "project",
        siteRef: "site-alpha",
        projectRef: "project-alpha",
      },
      featurePolicyRevisionRef: "feature-policy-r7",
      recordedAt: "2026-07-30T12:00:00.000Z",
    });
    const narrowed = createAgentProductMemorySpace({
      spaceRef: "space-agent-product-1",
      binding: {
        kind: "agent_product",
        parentSpaceRef: project.spaceRef,
        parentBinding: project.binding,
        parentSpaceGeneration: project.spaceGeneration,
        parentLearningGeneration: project.learningGeneration,
        parentRevocationEpoch: project.revocationEpoch,
        agentOptionRef: "agent-option-1",
        productSurfaceRef: "chat",
      },
      parent: project,
      featurePolicyRevisionRef: "feature-policy-r7",
      recordedAt: "2026-07-30T12:00:00.000Z",
    });

    expect(project.binding).toEqual({ kind: "project", siteRef: "site-alpha",
      projectRef: "project-alpha" });

    expect(narrowed.binding).toMatchObject({
      kind: "agent_product",
      parentSpaceRef: project.spaceRef,
      parentBinding: { kind: "project", siteRef: "site-alpha", projectRef: "project-alpha" },
      parentSpaceGeneration: 1n,
      parentLearningGeneration: 1n,
      parentRevocationEpoch: 1n,
    });
    expect(() => createAgentProductMemorySpace({
      spaceRef: "space-invalid",
      binding: {
        kind: "agent_product",
        parentSpaceRef: project.spaceRef,
        parentBinding: project.binding,
        parentSpaceGeneration: project.spaceGeneration,
        parentLearningGeneration: project.learningGeneration,
        parentRevocationEpoch: project.revocationEpoch,
        agentOptionRef: "agent-option-1",
        productSurfaceRef: "chat",
        subjectRef: "subject-other",
      },
      parent: project,
      featurePolicyRevisionRef: "feature-policy-r7",
      recordedAt: "2026-07-30T12:00:00.000Z",
    })).toThrowError(expect.objectContaining({ code: "MEMORY_SCOPE_INVALID" }));
    expect(() => createMemorySpace({
      spaceRef: "space-workspace",
      binding: { kind: "workspace", siteRef: "site-alpha", workspaceRef: "workspace-alpha" },
      featurePolicyRevisionRef: "feature-policy-r7",
      recordedAt: "2026-07-30T12:00:00.000Z",
    })).toThrowError(expect.objectContaining({ code: "MEMORY_SCOPE_INVALID" }));
  });

  it("defensively owns protected ciphertext and never returns an internal alias", () => {
    const source = new Uint8Array([1, 2, 3]);
    const nonce = new Uint8Array(12).fill(1);
    const authenticationTag = new Uint8Array(16).fill(2);
    const content = createProtectedMemoryContent({
      envelopeVersion: 1, ciphertext: source,
      keyRevision: "memory-key-r2",
      nonce, authenticationTag,
      aadDigest: "a".repeat(64),
    });
    source[0] = 9;
    nonce[0] = 9;
    authenticationTag[0] = 9;
    const first = content.copyCiphertext();
    expect([...first]).toEqual([1, 2, 3]);
    expect([...content.copyNonce()]).toEqual([...new Uint8Array(12).fill(1)]);
    expect([...content.copyAuthenticationTag()]).toEqual([...new Uint8Array(16).fill(2)]);
    first[1] = 8;
    const firstNonce = content.copyNonce();
    const firstAuthenticationTag = content.copyAuthenticationTag();
    firstNonce[1] = 8;
    firstAuthenticationTag[1] = 8;
    const second = content.copyCiphertext();
    expect(second).not.toBe(first);
    expect([...second]).toEqual([1, 2, 3]);
    expect(content.copyNonce()[1]).toBe(1);
    expect(content.copyAuthenticationTag()[1]).toBe(2);
    expect("ProtectedMemoryContent" in protectedContentModule).toBe(false);
    expect(() => Reflect.construct(content.constructor, [new Uint8Array([7]),
      "memory-key-r2", "a".repeat(64)])).toThrowError(
      expect.objectContaining({ code: "MEMORY_PROTECTED_CONTENT_INVALID" }),
    );
    const metadataBefore = protectedContentModule.protectedMemoryContentDigestMetadata(content);
    const prototype = Object.getPrototypeOf(content) as object;
    expect(() => Object.defineProperty(prototype, "copyCiphertext", {
      value: () => new Uint8Array([9]), configurable: true,
    })).toThrow(TypeError);
    expect(() => {
      (prototype as { copyCiphertext: () => Uint8Array }).copyCiphertext =
        () => new Uint8Array([9]);
    }).toThrow(TypeError);
    expect(protectedContentModule.protectedMemoryContentDigestMetadata(content)).toEqual(metadataBefore);
    expect([...content.copyCiphertext()]).toEqual([1, 2, 3]);
  });
});

describe("Memory M0 owner aggregates", () => {
  it("advances learning and use controls monotonically with exact transition semantics", () => {
    const initial = userSpace();
    const learningPaused = pauseMemoryLearning({ space: initial, expectedVersion: 1n,
      changedAt: "2026-07-30T12:01:00.000Z" });
    expect(learningPaused).toMatchObject({ version: 2n, learningGeneration: 2n,
      learningState: "paused", useState: "active" });
    expect(() => pauseMemoryLearning({ space: learningPaused, expectedVersion: 2n,
      changedAt: "2026-07-30T12:02:00.000Z" }))
      .toThrowError(expect.objectContaining({ code: "MEMORY_LEARNING_STATE_CONFLICT" }));

    const learningResumed = resumeMemoryLearning({ space: learningPaused, expectedVersion: 2n,
      resumeCutoffOriginSequence: 10n, changedAt: "2026-07-30T12:02:00.000Z" });
    expect(learningResumed).toMatchObject({ version: 3n, learningGeneration: 3n,
      minimumLearnableSourceOriginSequence: 11n, learningState: "active" });

    const usePaused = pauseMemoryUse({ space: learningResumed, expectedVersion: 3n,
      changedAt: "2026-07-30T12:03:00.000Z" });
    expect(usePaused).toMatchObject({ version: 4n, revocationEpoch: 2n, useState: "paused" });
    const useResumed = resumeMemoryUse({ space: usePaused, expectedVersion: 4n,
      changedAt: "2026-07-30T12:04:00.000Z" });
    expect(useResumed).toMatchObject({ version: 5n, revocationEpoch: 2n, useState: "active" });

    const reset = resetMemorySpace({ space: useResumed, expectedVersion: 5n,
      resetCutoffOriginSequence: 20n, changedAt: "2026-07-30T12:05:00.000Z" });
    expect(reset).toMatchObject({ version: 6n, spaceGeneration: 2n,
      learningGeneration: 4n, revocationEpoch: 3n,
      minimumLearnableSourceOriginSequence: 21n, learningState: "paused", useState: "paused" });
    expect(() => resumeMemoryUse({ space: reset, expectedVersion: 4n,
      changedAt: "2026-07-30T12:06:00.000Z" }))
      .toThrowError(expect.objectContaining({ code: "MEMORY_VERSION_CONFLICT" }));
  });

  it("creates stable entry identity and append-only explicit/corrected revision lineage", () => {
    const space = userSpace();
    const remembered = createRememberedMemory({
      space,
      entryRef: "memory-entry-1",
      revisionRef: "memory-revision-1",
      provenanceRef: "memory-provenance-1",
      sourceCommandRef: "memory-command-1",
      sourceDigest: "b".repeat(64),
      protectedContent: protectedContent(),
      category: "preference",
      featurePolicyRevisionRef: space.featurePolicyRevisionRef,
      actorAuthorization: userActorAuthorization,
      validFrom: null,
      validTo: null,
      recordedAt: "2026-07-30T12:10:00.000Z",
    });
    expect(remembered.entry).toMatchObject({ entryRef: "memory-entry-1", version: 1n,
      currentRevision: 1n, state: "active", revocationEpoch: 1n });
    expect(remembered.revision).toMatchObject({ revisionRef: "memory-revision-1",
      revision: 1n, reason: "explicit", supersedesRevisionRef: null });
    expect(remembered.provenance).toMatchObject({ sourceKind: "authenticated_user_command",
      sourceRef: "memory-command-1", revisionRef: "memory-revision-1" });

    const corrected = correctMemoryEntry({
      space, entry: remembered.entry,
      expectedVersion: 1n,
      expectedCurrentRevision: 1n,
      revisionRef: "memory-revision-2",
      provenanceRef: "memory-provenance-2",
      sourceCommandRef: "memory-command-2",
      sourceDigest: "c".repeat(64),
      protectedContent: protectedContent([4, 5, 6]),
      featurePolicyRevisionRef: space.featurePolicyRevisionRef,
      actorAuthorization: userActorAuthorization,
      validFrom: null,
      validTo: null,
      recordedAt: "2026-07-30T12:11:00.000Z",
    });
    expect(corrected.entry).toMatchObject({ entryRef: remembered.entry.entryRef,
      version: 2n, currentRevision: 2n });
    expect(corrected.revision).toMatchObject({ revision: 2n, reason: "corrected",
      supersedesRevisionRef: remembered.revision.revisionRef });
    expect(remembered.entry).toMatchObject({ version: 1n, currentRevision: 1n });
    expect(remembered.revision).toMatchObject({ revision: 1n, reason: "explicit" });
  });

  it("binds explicit writes to current fences even while learning or use is paused", () => {
    const usePaused = pauseMemoryUse({ space: userSpace(), expectedVersion: 1n,
      changedAt: "2026-07-30T12:01:00.000Z" });
    const remembered = createRememberedMemory({
      space: usePaused, entryRef: "memory-entry-2", revisionRef: "memory-revision-2",
      provenanceRef: "memory-provenance-2", sourceCommandRef: "memory-command-2",
      sourceDigest: "d".repeat(64), protectedContent: protectedContent(), category: "fact",
      featurePolicyRevisionRef: usePaused.featurePolicyRevisionRef,
      actorAuthorization: userActorAuthorization,
      validFrom: null,
      validTo: null,
      recordedAt: "2026-07-30T12:02:00.000Z",
    });
    expect(remembered.entry.revocationEpoch).toBe(usePaused.revocationEpoch);

    const learningPaused = pauseMemoryLearning({ space: userSpace(), expectedVersion: 1n,
      changedAt: "2026-07-30T12:01:00.000Z" });
    const explicitlyRemembered = createRememberedMemory({
      space: learningPaused, entryRef: "memory-entry-3", revisionRef: "memory-revision-3",
      provenanceRef: "memory-provenance-3", sourceCommandRef: "memory-command-3",
      sourceDigest: "e".repeat(64), protectedContent: protectedContent(), category: "fact",
      featurePolicyRevisionRef: learningPaused.featurePolicyRevisionRef,
      actorAuthorization: userActorAuthorization,
      validFrom: null,
      validTo: null,
      recordedAt: "2026-07-30T12:02:00.000Z",
    });
    expect(explicitlyRemembered.entry).toMatchObject({ learningGeneration: 2n, state: "active" });

    const corrected = correctMemoryEntry({
      space: learningPaused, entry: explicitlyRemembered.entry,
      expectedVersion: 1n, expectedCurrentRevision: 1n,
      revisionRef: "memory-revision-4", provenanceRef: "memory-provenance-4",
      sourceCommandRef: "memory-command-4", sourceDigest: "f".repeat(64),
      protectedContent: protectedContent([4, 5, 6]),
      featurePolicyRevisionRef: learningPaused.featurePolicyRevisionRef,
      actorAuthorization: userActorAuthorization,
      validFrom: null,
      validTo: null,
      recordedAt: "2026-07-30T12:03:00.000Z",
    });
    expect(corrected.revision).toMatchObject({ reason: "corrected", revision: 2n });
  });

  it("forgets through a logical tombstone and advances both entry and space use fences", () => {
    const space = userSpace();
    const remembered = createRememberedMemory({
      space, entryRef: "memory-entry-1", revisionRef: "memory-revision-1",
      provenanceRef: "memory-provenance-1", sourceCommandRef: "memory-command-1",
      sourceDigest: "b".repeat(64), protectedContent: protectedContent(), category: "fact",
      featurePolicyRevisionRef: space.featurePolicyRevisionRef,
      actorAuthorization: userActorAuthorization,
      validFrom: null,
      validTo: null,
      recordedAt: "2026-07-30T12:10:00.000Z",
    });
    const forgotten = forgetMemoryEntry({ space, entry: remembered.entry,
      expectedSpaceVersion: 1n, expectedEntryVersion: 1n,
      forgottenAt: "2026-07-30T12:12:00.000Z" });

    expect(forgotten.space).toMatchObject({ version: 2n, revocationEpoch: 2n });
    expect(forgotten.entry).toMatchObject({ version: 2n, state: "deleted", revocationEpoch: 2n });
    expect(forgotten.entry.currentRevision).toBe(remembered.entry.currentRevision);
    expect(() => correctMemoryEntry({
      space, entry: forgotten.entry, expectedVersion: 2n, expectedCurrentRevision: 1n,
      revisionRef: "memory-revision-2", provenanceRef: "memory-provenance-2",
      sourceCommandRef: "memory-command-2", sourceDigest: "c".repeat(64),
      protectedContent: protectedContent([4]), featurePolicyRevisionRef: space.featurePolicyRevisionRef,
      actorAuthorization: userActorAuthorization,
      validFrom: null,
      validTo: null,
      recordedAt: "2026-07-30T12:13:00.000Z",
    })).toThrowError(expect.objectContaining({ code: "MEMORY_ENTRY_STATE_CONFLICT" }));
  });

  it("permanently fences an entry after its space reset", () => {
    const space = userSpace();
    const remembered = createRememberedMemory({
      space, entryRef: "memory-entry-stale", revisionRef: "memory-revision-stale-1",
      provenanceRef: "memory-provenance-stale-1", sourceCommandRef: "memory-command-stale-1",
      sourceDigest: "7".repeat(64), protectedContent: protectedContent(), category: "fact",
      featurePolicyRevisionRef: space.featurePolicyRevisionRef,
      actorAuthorization: userActorAuthorization,
      validFrom: null,
      validTo: null,
      recordedAt: "2026-07-30T12:01:00.000Z",
    });
    const reset = resetMemorySpace({ space, expectedVersion: space.version,
      resetCutoffOriginSequence: 20n, changedAt: "2026-07-30T12:02:00.000Z" });

    expect(() => correctMemoryEntry({
      space: reset, entry: remembered.entry, expectedVersion: remembered.entry.version,
      expectedCurrentRevision: remembered.entry.currentRevision,
      revisionRef: "memory-revision-stale-2", provenanceRef: "memory-provenance-stale-2",
      sourceCommandRef: "memory-command-stale-2", sourceDigest: "8".repeat(64),
      protectedContent: protectedContent([4]), featurePolicyRevisionRef: reset.featurePolicyRevisionRef,
      actorAuthorization: userActorAuthorization,
      validFrom: null,
      validTo: null,
      recordedAt: "2026-07-30T12:03:00.000Z",
    })).toThrowError(expect.objectContaining({ code: "MEMORY_ENTRY_FENCE_CONFLICT" }));
    expect(() => forgetMemoryEntry({ space: reset, entry: remembered.entry,
      expectedSpaceVersion: reset.version, expectedEntryVersion: remembered.entry.version,
      forgottenAt: "2026-07-30T12:03:00.000Z",
    })).toThrowError(expect.objectContaining({ code: "MEMORY_ENTRY_FENCE_CONFLICT" }));
  });

  it("rebinds feature policy by CAS and advances every invalidation fence", () => {
    const initial = userSpace();
    const rebound = rebindMemoryFeaturePolicy({
      space: initial,
      expectedVersion: initial.version,
      expectedFeaturePolicyRevisionRef: initial.featurePolicyRevisionRef,
      nextFeaturePolicyRevisionRef: "feature-policy-r8",
      rebindCutoffOriginSequence: 30n,
      changedAt: "2026-07-30T12:04:00.000Z",
    });

    expect(rebound).toMatchObject({ featurePolicyRevisionRef: "feature-policy-r8", version: 2n,
      spaceGeneration: 2n, learningGeneration: 2n, revocationEpoch: 2n,
      minimumLearnableSourceOriginSequence: 31n, learningState: "paused", useState: "paused" });
    expect(() => rebindMemoryFeaturePolicy({
      space: initial, expectedVersion: initial.version,
      expectedFeaturePolicyRevisionRef: "feature-policy-r6",
      nextFeaturePolicyRevisionRef: "feature-policy-r8",
      rebindCutoffOriginSequence: 30n,
      changedAt: "2026-07-30T12:04:00.000Z",
    })).toThrowError(expect.objectContaining({ code: "MEMORY_FEATURE_POLICY_CONFLICT" }));
  });
});
