import { describe, expect, it } from "vitest";
import { SiteActiveReleaseAuthority } from
  "../../src/modules/site/application/services/site-active-release-authority.js";
import type { SiteActivationAuthoritySnapshot, SiteActiveReleasePointer } from
  "../../src/modules/site/application/contracts/site-activation-authority.js";

const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;
const candidateBinding = Object.freeze({ ref: "candidate.alpha", version: 2n,
  authorizationEpoch: 7n, digest: digestA });
const releaseBinding = Object.freeze({ ref: "site-release.alpha", revision: 2n, digest: digestB });
const activation = Object.freeze({ attemptRef: "attempt.alpha", siteRef: "site.alpha",
  environment: "production", candidate: candidateBinding, release: releaseBinding,
  expectedPointerGeneration: 0n, attemptDigest: digestA });

describe("SiteActiveReleaseAuthority", () => {
  it("captures begin/pre-CAS heads and atomically advances the exact pointer generation", async () => {
    const fixture = authorityFixture();
    const begin = await fixture.owner.captureBegin({} as never, activation);
    const result = await fixture.owner.commit({} as never, { ...activation, commandId: "command.commit" });

    expect(begin).toEqual({ replayed: false, snapshotDigest: digestA });
    expect(result).toEqual({ replayed: false, generation: 1n, release: releaseBinding });
    expect(fixture.snapshots.map((value) => value.phase)).toEqual(["begin", "pre-cas"]);
    expect(fixture.commits).toHaveLength(1);
    expect(fixture.pointer.generation).toBe(1n);
  });

  it("fails closed when any mutable trust head changes during activation", async () => {
    const fixture = authorityFixture();
    await fixture.owner.captureBegin({} as never, activation);
    fixture.trustPolicyHead = digestB;

    await expect(fixture.owner.commit({} as never, {
      ...activation,
      commandId: "command.commit",
    })).rejects.toThrow("SITE_ACTIVATION_AUTHORITY_CHANGED");
    expect(fixture.commits).toHaveLength(0);
    expect(fixture.pointer.generation).toBe(0n);
  });

  it("rejects stale generation instead of overwriting a newer active release", async () => {
    const fixture = authorityFixture();
    fixture.pointer = Object.freeze({ ...fixture.pointer, generation: 3n });
    await expect(fixture.owner.captureBegin({} as never, activation))
      .rejects.toThrow("SITE_ACTIVATION_POINTER_GENERATION_CONFLICT");
  });
});

function authorityFixture() {
  const state: {
    pointer: SiteActiveReleasePointer;
    snapshots: SiteActivationAuthoritySnapshot[];
    commits: unknown[];
    trustPolicyHead: string;
  } = {
    pointer: Object.freeze({ siteRef: "site.alpha", environment: "production", generation: 0n,
      activeRelease: null, authorizationEpoch: 1n }),
    snapshots: [],
    commits: [],
    trustPolicyHead: digestA,
  };
  const publications = {
    loadCandidateForUpdate: async () => ({ binding: candidateBinding, siteRef: "site.alpha",
      environment: "production", state: "authorized" }),
    loadNodeForUpdate: async () => ({ binding: releaseBinding }),
  };
  const pointers = {
    loadPointerForUpdate: async () => state.pointer,
    loadSnapshot: async (_transaction: unknown, _attemptRef: string, phase: string) =>
      state.snapshots.find((snapshot) => snapshot.phase === phase) ?? null,
    insertSnapshot: async (_transaction: unknown, snapshot: SiteActivationAuthoritySnapshot) => {
      state.snapshots.push(snapshot);
    },
    commitPointer: async (_transaction: unknown, input: { release: typeof releaseBinding;
      authorizationEpoch: bigint }) => {
      state.commits.push(input);
      state.pointer = Object.freeze({ ...state.pointer, generation: state.pointer.generation + 1n,
        activeRelease: input.release, authorizationEpoch: input.authorizationEpoch });
      return state.pointer;
    },
  };
  const authority = {
    read: async (_transaction: unknown, input: typeof activation & { phase: "begin" | "pre-cas";
      activePointerGeneration: bigint }) => Object.freeze({
      attemptRef: input.attemptRef,
      phase: input.phase,
      siteRef: input.siteRef,
      environment: input.environment,
      candidate: input.candidate,
      release: input.release,
      certificationRevocationEpoch: 0n,
      producerRegistryHeadDigest: digestA,
      trustPolicyHeadDigest: state.trustPolicyHead,
      signingKeyHeadDigest: digestA,
      activePointerGeneration: input.activePointerGeneration,
      attemptDigest: input.attemptDigest,
      snapshotDigest: input.phase === "begin" ? digestA : digestB,
      observedAt: "2026-08-01T00:00:00.000Z",
    }),
  };
  const owner = new SiteActiveReleaseAuthority(publications as never, pointers as never, authority as never,
    () => "2026-08-01T00:00:01.000Z");
  return Object.assign(state, { owner });
}
