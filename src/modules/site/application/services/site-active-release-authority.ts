import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import { canonicalDigest } from "../../../product-catalog/domain/canonical-product-document.js";
import type {
  SiteActivationAuthorityReaderPort,
  SiteActivationPointerRepository,
} from "../contracts/site-activation-authority.js";
import type { SitePublicationAuthorityRepository } from
  "../contracts/site-publication-authority-ports.js";
import type { CandidateAuthorityBinding, ImmutableRevisionBinding } from
  "../../domain/site-publication-authority.js";

/**
 * Transaction-local activation policy. The lifecycle command remains the only
 * unit-of-work and idempotency owner; this component must be called inside it.
 */
export class SiteActiveReleaseAuthority {
  constructor(
    private readonly publications: SitePublicationAuthorityRepository,
    private readonly pointers: SiteActivationPointerRepository,
    private readonly authority: SiteActivationAuthorityReaderPort,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async captureBegin(transaction: PlatformTransaction, input: ActivationInput) {
    const existing = await this.pointers.loadSnapshot(transaction, input.attemptRef, "begin");
    const { pointer } = await this.lockTarget(transaction, input, false);
    if (existing !== null) {
      validateSnapshot(existing, input, input.expectedPointerGeneration, "begin");
      return Object.freeze({ replayed: true, snapshotDigest: existing.snapshotDigest });
    }
    const snapshot = await this.authority.read(transaction, {
      ...input,
      phase: "begin",
      activePointerGeneration: pointer.generation,
    });
    validateSnapshot(snapshot, input, pointer.generation, "begin");
    await this.pointers.insertSnapshot(transaction, snapshot);
    return Object.freeze({ replayed: false, snapshotDigest: snapshot.snapshotDigest });
  }

  async commit(transaction: PlatformTransaction, input: ActivationInput & Readonly<{
    commandId: string;
  }>) {
    const begin = await this.pointers.loadSnapshot(transaction, input.attemptRef, "begin");
    if (begin === null) throw new Error("SITE_ACTIVATION_BEGIN_AUTHORITY_SNAPSHOT_REQUIRED");
    validateSnapshot(begin, input, input.expectedPointerGeneration, "begin");

    const { candidate, release, pointer } = await this.lockTarget(transaction, input, true);
    if (pointer.generation === input.expectedPointerGeneration + 1n &&
        sameRevision(pointer.activeRelease, release.binding)) {
      const existing = await this.pointers.loadSnapshot(transaction, input.attemptRef, "pre-cas");
      if (existing === null) throw new Error("SITE_ACTIVATION_POINTER_REPLAY_EVIDENCE_MISSING");
      validateSnapshot(existing, input, input.expectedPointerGeneration, "pre-cas");
      return Object.freeze({ replayed: true, generation: pointer.generation, release: release.binding });
    }
    if (pointer.generation !== input.expectedPointerGeneration) {
      throw new Error("SITE_ACTIVATION_POINTER_GENERATION_CONFLICT");
    }

    const preCas = await this.authority.read(transaction, {
      ...input,
      phase: "pre-cas",
      activePointerGeneration: pointer.generation,
    });
    validateSnapshot(preCas, input, pointer.generation, "pre-cas");
    assertStableAuthority(begin, preCas);
    await this.pointers.insertSnapshot(transaction, preCas);

    const evaluatedAt = this.now();
    const eligibilityDigest = canonicalDigest({
      contract: "kokoro.activation-eligibility-evidence.v1",
      attemptRef: input.attemptRef,
      attemptDigest: input.attemptDigest,
      beginSnapshotDigest: begin.snapshotDigest,
      preCasSnapshotDigest: preCas.snapshotDigest,
      expectedPointerGeneration: input.expectedPointerGeneration.toString(),
      evaluatedAt,
    });
    const next = await this.pointers.commitPointer(transaction, {
      pointer,
      release: release.binding,
      authorizationEpoch: candidate.binding.authorizationEpoch,
      commandId: input.commandId,
      beginSnapshotDigest: begin.snapshotDigest,
      preCasSnapshotDigest: preCas.snapshotDigest,
      eligibilityDigest,
      evaluatedAt,
    });
    return Object.freeze({ replayed: false, generation: next.generation, release: release.binding });
  }

  private async lockTarget(
    transaction: PlatformTransaction,
    input: ActivationInput,
    allowCommittedReplay: boolean,
  ) {
    const candidate = await this.publications.loadCandidateForUpdate(transaction, input.candidate.ref);
    if (candidate === null || candidate.state !== "authorized" || candidate.siteRef !== input.siteRef ||
        candidate.environment !== input.environment || !sameCandidate(candidate.binding, input.candidate)) {
      throw new Error("SITE_ACTIVATION_CANDIDATE_INVALID");
    }
    const release = await this.publications.loadNodeForUpdate(
      transaction,
      "site-release",
      input.candidate.ref,
      input.candidate.version,
    );
    if (release === null || !sameRevision(release.binding, input.release)) {
      throw new Error("SITE_ACTIVATION_RELEASE_INVALID");
    }
    const pointer = await this.pointers.loadPointerForUpdate(transaction, input);
    const validGeneration = pointer.generation === input.expectedPointerGeneration ||
      (allowCommittedReplay && pointer.generation === input.expectedPointerGeneration + 1n &&
        sameRevision(pointer.activeRelease, release.binding));
    if (!validGeneration) throw new Error("SITE_ACTIVATION_POINTER_GENERATION_CONFLICT");
    return { candidate, release, pointer };
  }
}

export interface SiteActivationAuthorityInput {
  readonly attemptRef: string;
  readonly siteRef: string;
  readonly environment: string;
  readonly candidate: CandidateAuthorityBinding;
  readonly release: ImmutableRevisionBinding;
  readonly expectedPointerGeneration: bigint;
  readonly attemptDigest: string;
}
type ActivationInput = SiteActivationAuthorityInput;

function validateSnapshot(
  snapshot: Awaited<ReturnType<SiteActivationAuthorityReaderPort["read"]>>,
  input: ActivationInput,
  generation: bigint,
  phase: "begin" | "pre-cas",
): void {
  if (snapshot.phase !== phase || snapshot.attemptRef !== input.attemptRef ||
      snapshot.siteRef !== input.siteRef || snapshot.environment !== input.environment ||
      snapshot.attemptDigest !== input.attemptDigest || snapshot.activePointerGeneration !== generation ||
      !sameCandidate(snapshot.candidate, input.candidate) || !sameRevision(snapshot.release, input.release)) {
    throw new Error("SITE_ACTIVATION_AUTHORITY_SNAPSHOT_INVALID");
  }
  for (const value of [snapshot.certificationRevocationEpoch.toString(), generation.toString()]) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
      throw new Error("SITE_ACTIVATION_AUTHORITY_SNAPSHOT_INVALID");
    }
  }
  for (const value of [snapshot.producerRegistryHeadDigest, snapshot.trustPolicyHeadDigest,
    snapshot.signingKeyHeadDigest, snapshot.attemptDigest, snapshot.snapshotDigest]) {
    if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {
      throw new Error("SITE_ACTIVATION_AUTHORITY_SNAPSHOT_INVALID");
    }
  }
  if (!Number.isFinite(Date.parse(snapshot.observedAt)) ||
      new Date(snapshot.observedAt).toISOString() !== snapshot.observedAt) {
    throw new Error("SITE_ACTIVATION_AUTHORITY_SNAPSHOT_INVALID");
  }
}
function sameCandidate(left: CandidateAuthorityBinding, right: CandidateAuthorityBinding): boolean {
  return left.ref === right.ref && left.version === right.version &&
    left.authorizationEpoch === right.authorizationEpoch && left.digest === right.digest;
}
function assertStableAuthority(
  begin: Awaited<ReturnType<SiteActivationAuthorityReaderPort["read"]>>,
  preCas: Awaited<ReturnType<SiteActivationAuthorityReaderPort["read"]>>,
): void {
  if (begin.certificationRevocationEpoch !== preCas.certificationRevocationEpoch ||
      begin.producerRegistryHeadDigest !== preCas.producerRegistryHeadDigest ||
      begin.trustPolicyHeadDigest !== preCas.trustPolicyHeadDigest ||
      begin.signingKeyHeadDigest !== preCas.signingKeyHeadDigest) {
    throw new Error("SITE_ACTIVATION_AUTHORITY_CHANGED");
  }
}
function sameRevision(left: ImmutableRevisionBinding | null, right: ImmutableRevisionBinding): boolean {
  return left !== null && left.ref === right.ref && left.revision === right.revision && left.digest === right.digest;
}
