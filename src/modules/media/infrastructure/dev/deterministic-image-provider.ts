import { createHash } from "node:crypto";
import type {
  MediaImageEffectCommandReceipt,
  MediaImageEffectCommandResult,
  MediaImageEffectEvidenceFact,
  MediaImageEffectPort,
  MediaImageEffectView,
} from "../../application/image-operation-worker.js";

type Invocation = Readonly<{
  result: MediaImageEffectCommandResult;
  evidence: readonly MediaImageEffectEvidenceFact[];
}>;

/** Development-only Model Gateway contract fake. Production composition rejects it. */
export class DeterministicDevelopmentImageProviderAdapter implements MediaImageEffectPort {
  readonly developmentOnly = true as const;
  readonly #byCommand = new Map<string, Invocation>();
  readonly #events: string[];
  invocationCount = 0;

  constructor(events: string[] = []) { this.#events = events; }

  async create(input: Parameters<MediaImageEffectPort["create"]>[0]): Promise<MediaImageEffectCommandResult> {
    aborted(input.signal);
    if (this.#byCommand.has(input.modelInvocationCommandRef)) throw new Error("DEVELOPMENT_GATEWAY_CREATE_CONFLICT");
    this.#events.push("gateway.create"); this.invocationCount += 1;
    const invocation = outcome(input);
    this.#byCommand.set(input.modelInvocationCommandRef, invocation);
    return invocation.result;
  }

  async recoverByCommand(
    input: Parameters<MediaImageEffectPort["recoverByCommand"]>[0],
  ): Promise<MediaImageEffectCommandResult> {
    aborted(input.signal); this.#events.push("gateway.recover");
    const found = this.#byCommand.get(input.callerCommandRef);
    if (found !== undefined) return found.result;
    const requestDigest = digest(input.callerCommandRef);
    return Object.freeze({ receipt: receipt(input.callerCommandRef, requestDigest,
      "definitely_not_submitted", undefined) });
  }

  async getByCommand(input: Parameters<MediaImageEffectPort["getByCommand"]>[0]): Promise<MediaImageEffectView> {
    aborted(input.signal); this.#events.push("gateway.get");
    const found = this.#byCommand.get(input.modelInvocationCommandRef);
    if (found?.result.invocation === undefined) throw new Error("DEVELOPMENT_GATEWAY_INVOCATION_NOT_FOUND");
    return found.result.invocation;
  }

  async getEvidence(
    input: Parameters<MediaImageEffectPort["getEvidence"]>[0],
  ): Promise<Awaited<ReturnType<MediaImageEffectPort["getEvidence"]>>> {
    aborted(input.signal); this.#events.push("gateway.evidence.get");
    const found = [...this.#byCommand.values()].find((value) =>
      value.result.invocation?.logicalInvocationRef === input.logicalInvocationRef);
    if (found?.result.invocation === undefined) throw new Error("DEVELOPMENT_GATEWAY_INVOCATION_NOT_FOUND");
    const facts = found.evidence.filter((fact) => fact.evidenceSequence > input.afterEvidenceSequence)
      .slice(0, input.limit);
    const next = facts.at(-1)?.evidenceSequence ?? input.afterEvidenceSequence;
    return Object.freeze({ invocation: found.result.invocation,
      evidenceFacts: Object.freeze(facts), nextEvidenceSequence: next,
      caughtUp: next >= (found.evidence.at(-1)?.evidenceSequence ?? 0n) });
  }

  async requestCancel(
    input: Parameters<MediaImageEffectPort["requestCancel"]>[0],
  ): Promise<MediaImageEffectCommandResult> {
    aborted(input.signal); this.#events.push("gateway.cancel");
    const found = [...this.#byCommand.values()].find((value) =>
      value.result.invocation?.logicalInvocationRef === input.logicalInvocationRef);
    if (found?.result.invocation === undefined) throw new Error("DEVELOPMENT_GATEWAY_INVOCATION_NOT_FOUND");
    return Object.freeze({ receipt: receipt(input.cancelCommandRef, input.callerRequestFingerprint,
      "cancel_intent_committed", found.result.invocation.logicalInvocationRef), invocation: found.result.invocation });
  }
}

function outcome(input: Parameters<MediaImageEffectPort["create"]>[0]): Invocation {
  const commandRef = input.modelInvocationCommandRef;
  const value = digest(commandRef);
  const logicalInvocationRef = `image-invocation:${value}`;
  const outcomeEvidence = evidenceIdentity("outcome", value);
  const usageEvidence = evidenceIdentity("usage", value);
  const view: MediaImageEffectView = Object.freeze({ state: "succeeded" as const,
    logicalInvocationRef, modelInvocationCommandRef: commandRef, ownerVersion: 1n,
    currentAttemptOrdinal: 1, canonicalOutcomeEvidence: outcomeEvidence,
    usageEvidence, observedAt: "2099-01-01T00:00:00.000Z" });
  const facts: MediaImageEffectEvidenceFact[] = [Object.freeze({ evidenceSequence: 1n, kind: "outcome" as const,
    evidenceRef: outcomeEvidence.ref, evidenceDigest: outcomeEvidence.digest,
    recordedAt: "2099-01-01T00:00:00.000Z" }), Object.freeze({ evidenceSequence: 2n, kind: "usage" as const,
    evidenceRef: usageEvidence.ref, evidenceDigest: usageEvidence.digest,
    recordedAt: "2099-01-01T00:00:00.000Z" })];
  for (const slot of input.logicalOutputSlots) {
    const identity = evidenceIdentity(`output:${slot.candidateOrdinal}`, value);
    facts.push(Object.freeze({ evidenceSequence: BigInt(facts.length + 1), kind: "output" as const,
      evidenceRef: identity.ref, evidenceDigest: identity.digest, outputEvidenceRef: identity.ref,
      outputEvidenceDigest: identity.digest, candidateOrdinal: slot.candidateOrdinal,
      candidateRef: slot.candidateRef, stableOutputSlotRef: slot.stableOutputSlotRef,
      mediaType: "image/png" as const, width: 1, height: 1,
      recordedAt: "2099-01-01T00:00:00.000Z" }));
  }
  return Object.freeze({ result: Object.freeze({ receipt: receipt(commandRef, input.callerRequestFingerprint,
    "create_committed", logicalInvocationRef), invocation: view }), evidence: Object.freeze(facts) });
}

function receipt(
  commandRef: string,
  requestDigest: string,
  kind: MediaImageEffectCommandReceipt["kind"],
  logicalInvocationRef: string | undefined,
): MediaImageEffectCommandReceipt {
  const receiptDigest = digest(`${commandRef}:${requestDigest}:${kind}`);
  return Object.freeze({ receiptRef: `image-effect-receipt:sha256:${receiptDigest}`,
    receiptDigest, requestDigest, callerCommandRef: commandRef, kind,
    ...(logicalInvocationRef === undefined ? {} : { logicalInvocationRef }),
    receiptVersion: 1n, recordedAt: "2099-01-01T00:00:00.000Z" });
}

function evidenceIdentity(kind: string, value: string) {
  const evidenceDigest = digest(`${kind}:${value}`);
  return Object.freeze({ ref: `image-effect-${kind}-evidence:${evidenceDigest}`, digest: evidenceDigest });
}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function aborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}
