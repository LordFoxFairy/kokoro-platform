import {
  applyImageEffectObservation,
  type ImageEffectAttempt,
  type ImageEffectProviderObservation,
} from "../domain/image-effect.js";

export type ImageEffectDispatchSourceGrant = Readonly<{
  sourceVersionRef: string;
  /** A view over an owned ephemeral plaintext buffer; valid only during the loader callback. */
  purposeGrantHandle: Uint8Array;
}>;

export type ImageEffectDispatchClaim = Readonly<{
  siteId: string;
  attemptRef: string;
  logicalInvocationRef: string;
  dispatchOwnerRef: string;
  dispatchFence: bigint;
}>;

export type ImageEffectDispatchContext = Readonly<{
  siteId: string;
  logicalInvocationRef: string;
  definitionRoleRef: string;
  modelOptionRevisionRef: string;
  deploymentRef: string;
  adapterKind: string;
  providerModel: string;
  operationInputRevisionRef: string;
  operationInputRevisionDigest: string;
  sourceGrantRefs: readonly string[];
  logicalOutputSlots: readonly Readonly<{ candidateRef: string; stableOutputSlotRef: string }>[];
  attempt: ImageEffectAttempt;
}>;

export interface ImageEffectWorkerRepository {
  claim(input: Readonly<{ dispatchOwnerRef: string; leaseMilliseconds: number }>):
    Promise<ImageEffectDispatchClaim | null>;
  load(claim: ImageEffectDispatchClaim): Promise<ImageEffectDispatchContext>;
  heartbeat(claim: ImageEffectDispatchClaim, leaseMilliseconds: number): Promise<boolean>;
  recordObservation(
    claim: ImageEffectDispatchClaim,
    observation: ImageEffectProviderObservation,
    attempt: ImageEffectAttempt,
  ): Promise<ImageEffectAttempt | null>;
  /** Records a conservative owner observation after begin() may have crossed the Provider I/O boundary. */
  recordStartAmbiguity(claim: ImageEffectDispatchClaim, errorCode: string): Promise<ImageEffectAttempt | null>;
  /** Records a conservative owner observation after an established Provider stream becomes ambiguous. */
  recordStreamAmbiguity(claim: ImageEffectDispatchClaim, errorCode: string): Promise<ImageEffectAttempt | null>;
  /** May only be used while the worker can prove no Provider I/O was attempted. */
  deadLetterBeforeProviderIo(claim: ImageEffectDispatchClaim, errorCode: string): Promise<boolean>;
}

export interface ImageEffectWorkerSecretLoader {
  withSourceGrants<Result>(
    claim: ImageEffectDispatchClaim,
    work: (grants: readonly ImageEffectDispatchSourceGrant[]) => Promise<Result>,
  ): Promise<Result>;
}

export interface CertifiedImageEffectProvider {
  certification(): Readonly<{
    adapterKind: string;
    protocol: string;
    idempotency: string;
  }>;
  /** Resolving this promise means the adapter has consumed the ephemeral source buffers. */
  begin(
    context: ImageEffectDispatchContext,
    sourceGrants: readonly ImageEffectDispatchSourceGrant[],
    signal: AbortSignal,
  ): Promise<Readonly<{
    /** The adapter's durable classification of the submission boundary; persisted before the stream is consumed. */
    firstObservation: ImageEffectProviderObservation & Readonly<{
      kind: "definitely_not_submitted" | "submitted" | "submission_unknown";
    }>;
    observations: AsyncIterable<ImageEffectProviderObservation>;
  }>>;
}

export class ImageEffectDispatchWorker {
  readonly #ownerRef: string;
  readonly #leaseMilliseconds: number;

  constructor(private readonly dependencies: Readonly<{
    repository: ImageEffectWorkerRepository;
    secrets: ImageEffectWorkerSecretLoader;
    provider: CertifiedImageEffectProvider;
    dispatchOwnerRef: string;
    leaseMilliseconds: number;
  }>) {
    const certification = dependencies.provider.certification();
    if (certification.adapterKind !== "certified-image-v1" ||
        certification.protocol !== "kokoro.image-provider-effects.v1" ||
        certification.idempotency !== "provider-operation-key") {
      throw new Error("IMAGE_EFFECT_PROVIDER_CERTIFICATION_INVALID");
    }
    if (dependencies.dispatchOwnerRef.length < 1 || dependencies.dispatchOwnerRef.length > 128 ||
        !Number.isInteger(dependencies.leaseMilliseconds) || dependencies.leaseMilliseconds < 1_000 ||
        dependencies.leaseMilliseconds > 300_000) {
      throw new Error("IMAGE_EFFECT_WORKER_CONFIGURATION_INVALID");
    }
    this.#ownerRef = dependencies.dispatchOwnerRef;
    this.#leaseMilliseconds = dependencies.leaseMilliseconds;
  }

  async runOne(signal: AbortSignal = new AbortController().signal): Promise<boolean> {
    const claim = await this.dependencies.repository.claim({
      dispatchOwnerRef: this.#ownerRef,
      leaseMilliseconds: this.#leaseMilliseconds,
    });
    if (claim === null) return false;
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) controller.abort(signal.reason);
    let heartbeatPromise: Promise<void> | null = null;
    const heartbeat = setInterval(() => {
      if (heartbeatPromise !== null || controller.signal.aborted) return;
      heartbeatPromise = this.dependencies.repository.heartbeat(claim, this.#leaseMilliseconds)
        .then((alive) => { if (!alive) controller.abort(new ImageEffectDispatchFenceLost()); })
        .catch(() => controller.abort(new ImageEffectDispatchFenceLost()))
        .finally(() => { heartbeatPromise = null; });
    }, Math.max(250, Math.floor(this.#leaseMilliseconds / 3)));
    heartbeat.unref();
    let providerIoAttempted = false;
    try {
      const context = await this.dependencies.repository.load(claim);
      if (context.attempt.attemptRef !== claim.attemptRef ||
          context.logicalInvocationRef !== claim.logicalInvocationRef ||
          context.adapterKind !== "certified-image-v1") {
        throw new Error("IMAGE_EFFECT_DISPATCH_CONTEXT_INVALID");
      }
      let execution: Awaited<ReturnType<CertifiedImageEffectProvider["begin"]>>;
      try {
        execution = await this.dependencies.secrets.withSourceGrants(claim, async (grants) => {
          if (controller.signal.aborted) throw controller.signal.reason;
          providerIoAttempted = true;
          return this.dependencies.provider.begin(context, grants, controller.signal);
        });
      } catch (error) {
        if (isFenceLost(controller.signal.reason)) throw controller.signal.reason;
        if (controller.signal.aborted && !providerIoAttempted) throw controller.signal.reason;
        if (!providerIoAttempted) {
          await this.dependencies.repository.deadLetterBeforeProviderIo(claim, safeErrorCode(error));
        } else {
          const canonical = await this.dependencies.repository.recordStartAmbiguity(claim,
            controller.signal.aborted ? "IMAGE_EFFECT_WORKER_ABORTED_AFTER_PROVIDER_IO" : safeErrorCode(error));
          if (canonical === null) throw new ImageEffectDispatchFenceLost();
        }
        throw error;
      }
      let attempt: ImageEffectAttempt;
      try {
        const canonical = await this.#persistObservation(claim, context.attempt, execution.firstObservation);
        if (canonical === null) throw new ImageEffectDispatchFenceLost();
        attempt = canonical;
      } catch (error) {
        if (isFenceLost(controller.signal.reason) || isFenceLost(error)) throw error;
        const canonical = await this.dependencies.repository.recordStartAmbiguity(claim,
          controller.signal.aborted ? "IMAGE_EFFECT_WORKER_ABORTED_AFTER_PROVIDER_IO" : safeErrorCode(error));
        if (canonical === null) throw new ImageEffectDispatchFenceLost();
        throw error;
      }
      try {
        for await (const observation of execution.observations) {
          if (controller.signal.aborted) throw controller.signal.reason;
          const canonical = await this.#persistObservation(claim, attempt, observation);
          if (canonical === null) throw new ImageEffectDispatchFenceLost();
          attempt = canonical;
        }
      } catch (error) {
        if (isFenceLost(controller.signal.reason) || isFenceLost(error)) throw error;
        const canonical = await this.dependencies.repository.recordStreamAmbiguity(claim,
          controller.signal.aborted ? "IMAGE_EFFECT_WORKER_ABORTED_DURING_PROVIDER_STREAM" : safeErrorCode(error));
        if (canonical === null) throw new ImageEffectDispatchFenceLost();
        throw error;
      }
      return true;
    } finally {
      clearInterval(heartbeat);
      await heartbeatPromise;
      signal.removeEventListener("abort", onAbort);
      controller.abort(new Error("IMAGE_EFFECT_DISPATCH_COMPLETE"));
    }
  }

  async #persistObservation(
    claim: ImageEffectDispatchClaim,
    current: ImageEffectAttempt,
    observation: ImageEffectProviderObservation,
  ): Promise<ImageEffectAttempt | null> {
    const applied = applyImageEffectObservation(current, observation);
    const persisted = await this.dependencies.repository.recordObservation(claim, observation, applied.attempt);
    if (persisted !== null && (persisted.attemptRef !== claim.attemptRef ||
        persisted.ordinal !== current.ordinal || persisted.lastProviderSequence < current.lastProviderSequence)) {
      throw new Error("IMAGE_EFFECT_PERSISTED_ATTEMPT_INVALID");
    }
    return persisted;
  }
}

function safeErrorCode(error: unknown): string {
  const value = error instanceof Error ? error.message : "IMAGE_EFFECT_PROVIDER_UNKNOWN";
  return /^[A-Z0-9_]{1,128}$/u.test(value) ? value : "IMAGE_EFFECT_PROVIDER_UNKNOWN";
}

function isFenceLost(error: unknown): boolean {
  return error instanceof ImageEffectDispatchFenceLost;
}

class ImageEffectDispatchFenceLost extends Error {
  constructor() { super("IMAGE_EFFECT_DISPATCH_FENCE_LOST"); }
}
