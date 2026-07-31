export type ImageEffectAttemptState =
  | "planned"
  | "definitely_not_submitted"
  | "submitted"
  | "submission_unknown"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled"
  | "outcome_unknown";

import { createHash } from "node:crypto";

export type ImageEffectOutputEvidence = Readonly<{
  candidateRef: string;
  stableOutputSlotRef: string;
  providerOutputFactRef: string;
  retrievalGrantHandleDigest: string;
}>;

export type ImageEffectProviderOutput = Readonly<{
  candidateRef: string;
  stableOutputSlotRef: string;
  providerOutputFactRef: string;
  retrievalGrantHandle: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
  declaredByteSize?: bigint;
}>;

/** Certified provider usage normalized before it enters the Model Gateway owner journal. */
export type ImageEffectUsageFact = Readonly<{
  evidenceKind: "measured" | "zero" | "unavailable";
  dimensions: readonly Readonly<{
    dimensionKey: string;
    sourceUnit: string;
    quantity: bigint;
  }>[];
  attemptOutcome: "succeeded" | "failed_after_effect" | "canceled_after_effect";
  occurredAt: string;
  sourceDigest: string;
  unavailableReasonCode?: string | undefined;
}>;

type ObservationBase = Readonly<{
  eventRef: string;
  sequence: bigint;
  observationDigest: string;
  observedAt: string;
}>;

export type ImageEffectProviderObservation =
  | (ObservationBase & Readonly<{
      kind: "definitely_not_submitted";
      definitelyNotSubmittedReceiptRef: string;
      definitelyNotSubmittedReceiptDigest: string;
    }>)
  | (ObservationBase & Readonly<{
      kind: "submitted";
      providerOperationRef: string;
    }>)
  | (ObservationBase & Readonly<{ kind: "submission_unknown" | "running" }>)
  | (ObservationBase & Readonly<{
      kind: "succeeded";
      outcomeEvidenceRef: string;
      outcomeEvidenceDigest: string;
      usageEvidenceRef: string;
      usageEvidenceDigest: string;
      usageFact: ImageEffectUsageFact;
      outputs: readonly ImageEffectProviderOutput[];
    }>)
  | (ObservationBase & Readonly<{
      kind: "failed" | "canceled" | "outcome_unknown";
      outcomeEvidenceRef: string;
      outcomeEvidenceDigest: string;
      usageEvidenceRef?: string;
      usageEvidenceDigest?: string;
      usageFact?: ImageEffectUsageFact;
    }>);

export type ImageEffectAttempt = Readonly<{
  attemptRef: string;
  ordinal: number;
  budgetCommitRef: string;
  budgetCommitDigest: string;
  providerOperationKey: string;
  state: ImageEffectAttemptState;
  cancelRequested: boolean;
  lastProviderSequence: bigint;
  providerOperationRef?: string;
  definitelyNotSubmittedReceiptRef?: string;
  definitelyNotSubmittedReceiptDigest?: string;
  canonicalOutcomeEvidenceRef?: string;
  canonicalOutcomeEvidenceDigest?: string;
  usageEvidenceRef?: string;
  usageEvidenceDigest?: string;
  outputs: readonly ImageEffectOutputEvidence[];
  lateOutcome: boolean;
  observations: readonly Readonly<{ eventRef: string; digest: string; sequence: bigint }>[];
}>;

export function createImageEffectAttempt(input: Readonly<{
  attemptRef: string;
  ordinal: number;
  budgetCommitRef: string;
  budgetCommitDigest: string;
  providerOperationKey: string;
}>): ImageEffectAttempt {
  reference(input.attemptRef);
  positiveOrdinal(input.ordinal);
  reference(input.budgetCommitRef);
  digest(input.budgetCommitDigest);
  reference(input.providerOperationKey);
  return Object.freeze({
    ...input,
    state: "planned" as const,
    cancelRequested: false,
    lastProviderSequence: 0n,
    outputs: Object.freeze([]),
    lateOutcome: false,
    observations: Object.freeze([]),
  });
}

export function requestImageEffectCancellation(attempt: ImageEffectAttempt): ImageEffectAttempt {
  validateAttempt(attempt);
  if (isTerminal(attempt.state) && attempt.state !== "outcome_unknown") {
    throw new Error("IMAGE_EFFECT_ATTEMPT_ALREADY_TERMINAL");
  }
  if (attempt.cancelRequested) return attempt;
  return Object.freeze({ ...attempt, cancelRequested: true });
}

export function applyImageEffectObservation(
  attempt: ImageEffectAttempt,
  observation: ImageEffectProviderObservation,
): Readonly<{ attempt: ImageEffectAttempt; replayed: boolean }> {
  validateAttempt(attempt);
  validateObservation(observation);
  const prior = attempt.observations.find((item) => item.eventRef === observation.eventRef);
  if (prior !== undefined) {
    if (prior.digest !== observation.observationDigest || prior.sequence !== observation.sequence) {
      throw new Error("IMAGE_EFFECT_PROVIDER_EVENT_DIGEST_CONFLICT");
    }
    return Object.freeze({ attempt, replayed: true });
  }
  if (observation.sequence !== attempt.lastProviderSequence + 1n) {
    throw new Error("IMAGE_EFFECT_PROVIDER_EVENT_SEQUENCE_CONFLICT");
  }
  assertTransition(attempt.state, observation.kind);
  const observations = Object.freeze([...attempt.observations, Object.freeze({
    eventRef: observation.eventRef,
    digest: observation.observationDigest,
    sequence: observation.sequence,
  })]);
  const base = {
    ...attempt,
    state: observation.kind,
    lastProviderSequence: observation.sequence,
    observations,
  };
  let next: ImageEffectAttempt;
  switch (observation.kind) {
    case "definitely_not_submitted":
      next = Object.freeze({
        ...base,
        definitelyNotSubmittedReceiptRef: observation.definitelyNotSubmittedReceiptRef,
        definitelyNotSubmittedReceiptDigest: observation.definitelyNotSubmittedReceiptDigest,
      });
      break;
    case "submitted":
      next = Object.freeze({ ...base, providerOperationRef: observation.providerOperationRef });
      break;
    case "succeeded":
      next = Object.freeze({
        ...base,
        canonicalOutcomeEvidenceRef: observation.outcomeEvidenceRef,
        canonicalOutcomeEvidenceDigest: observation.outcomeEvidenceDigest,
        usageEvidenceRef: observation.usageEvidenceRef,
        usageEvidenceDigest: observation.usageEvidenceDigest,
        outputs: snapshotOutputs(observation.outputs),
        lateOutcome: attempt.state === "outcome_unknown",
      });
      break;
    case "failed":
    case "canceled":
    case "outcome_unknown":
      next = Object.freeze({
        ...base,
        canonicalOutcomeEvidenceRef: observation.outcomeEvidenceRef,
        canonicalOutcomeEvidenceDigest: observation.outcomeEvidenceDigest,
        ...(observation.usageEvidenceRef === undefined
          ? {}
          : {
              usageEvidenceRef: observation.usageEvidenceRef,
              usageEvidenceDigest: observation.usageEvidenceDigest,
            }),
        lateOutcome: attempt.state === "outcome_unknown" && observation.kind !== "outcome_unknown",
      });
      break;
    case "submission_unknown":
    case "running":
      next = Object.freeze(base);
      break;
  }
  return Object.freeze({ attempt: next, replayed: false });
}

function assertTransition(from: ImageEffectAttemptState, to: ImageEffectProviderObservation["kind"]): void {
  const allowed: Readonly<Record<ImageEffectAttemptState, readonly ImageEffectProviderObservation["kind"][]>> = {
    planned: ["definitely_not_submitted", "submitted", "submission_unknown"],
    definitely_not_submitted: [],
    submitted: ["running", "succeeded", "failed", "canceled", "outcome_unknown"],
    submission_unknown: ["submitted", "running", "succeeded", "failed", "canceled", "outcome_unknown"],
    running: ["running", "succeeded", "failed", "canceled", "outcome_unknown"],
    succeeded: [],
    failed: [],
    canceled: [],
    outcome_unknown: ["succeeded", "failed", "canceled"],
  };
  if (!allowed[from].includes(to)) throw new Error("IMAGE_EFFECT_PROVIDER_STATE_TRANSITION_INVALID");
}

function validateAttempt(attempt: ImageEffectAttempt): void {
  reference(attempt.attemptRef);
  positiveOrdinal(attempt.ordinal);
  reference(attempt.budgetCommitRef);
  digest(attempt.budgetCommitDigest);
  reference(attempt.providerOperationKey);
  if (attempt.lastProviderSequence < 0n || attempt.observations.length > 4096) {
    throw new Error("IMAGE_EFFECT_ATTEMPT_INVALID");
  }
}

function validateObservation(observation: ImageEffectProviderObservation): void {
  reference(observation.eventRef);
  if (observation.sequence < 1n || observation.sequence > 1_000_000n) {
    throw new Error("IMAGE_EFFECT_PROVIDER_EVENT_INVALID");
  }
  digest(observation.observationDigest);
  instant(observation.observedAt);
  if (observation.kind === "submitted") reference(observation.providerOperationRef);
  if (observation.kind === "definitely_not_submitted") {
    reference(observation.definitelyNotSubmittedReceiptRef);
    digest(observation.definitelyNotSubmittedReceiptDigest);
  }
  if (["succeeded", "failed", "canceled", "outcome_unknown"].includes(observation.kind)) {
    const terminal = observation as Extract<ImageEffectProviderObservation, {
      kind: "succeeded" | "failed" | "canceled" | "outcome_unknown";
    }>;
    reference(terminal.outcomeEvidenceRef);
    digest(terminal.outcomeEvidenceDigest);
    if ((terminal.usageEvidenceRef === undefined) !== (terminal.usageEvidenceDigest === undefined) ||
        (terminal.usageEvidenceRef === undefined) !== (terminal.usageFact === undefined)) {
      throw new Error("IMAGE_EFFECT_USAGE_EVIDENCE_INVALID");
    }
    if (terminal.usageEvidenceRef !== undefined) {
      reference(terminal.usageEvidenceRef);
      digest(terminal.usageEvidenceDigest!);
      validateUsageFact(terminal.usageFact!, terminal.kind);
      if (imageEffectUsageFactDigest(terminal.usageFact!) !== terminal.usageEvidenceDigest) {
        throw new Error("IMAGE_EFFECT_USAGE_EVIDENCE_DIGEST_MISMATCH");
      }
    }
  }
  if (observation.kind === "succeeded") {
    if (observation.outputs.length < 1 || observation.outputs.length > 4) {
      throw new Error("IMAGE_EFFECT_OUTPUT_EVIDENCE_INVALID");
    }
    snapshotOutputs(observation.outputs);
  }
}

function validateUsageFact(
  fact: ImageEffectUsageFact,
  terminalKind: "succeeded" | "failed" | "canceled" | "outcome_unknown",
): void {
  if (typeof fact !== "object" || fact === null || Array.isArray(fact) ||
      !["measured", "zero", "unavailable"].includes(fact.evidenceKind) ||
      !Array.isArray(fact.dimensions) || fact.dimensions.length > 64 ||
      !["succeeded", "failed_after_effect", "canceled_after_effect"].includes(fact.attemptOutcome)) {
    throw new Error("IMAGE_EFFECT_USAGE_FACT_INVALID");
  }
  instant(fact.occurredAt);
  digest(fact.sourceDigest);
  const expectedOutcome = terminalKind === "succeeded" ? "succeeded"
    : terminalKind === "failed" ? "failed_after_effect"
      : terminalKind === "canceled" ? "canceled_after_effect" : undefined;
  if (expectedOutcome === undefined || fact.attemptOutcome !== expectedOutcome ||
      (fact.evidenceKind === "measured") !== (fact.dimensions.length > 0) ||
      (fact.evidenceKind === "unavailable") !== (fact.unavailableReasonCode !== undefined)) {
    throw new Error("IMAGE_EFFECT_USAGE_FACT_INVALID");
  }
  const keys = new Set<string>();
  for (const dimension of fact.dimensions) {
    if (typeof dimension.dimensionKey !== "string" || typeof dimension.sourceUnit !== "string") {
      throw new Error("IMAGE_EFFECT_USAGE_FACT_INVALID");
    }
    usageKey(dimension.dimensionKey);
    usageKey(dimension.sourceUnit);
    if (typeof dimension.quantity !== "bigint" || dimension.quantity < 0n ||
        dimension.quantity > 99_999_999_999_999_999_999_999_999_999_999_999_999n ||
        keys.has(dimension.dimensionKey)) {
      throw new Error("IMAGE_EFFECT_USAGE_FACT_INVALID");
    }
    keys.add(dimension.dimensionKey);
  }
  if (fact.unavailableReasonCode !== undefined && !/^[A-Z0-9_]{1,128}$/u.test(fact.unavailableReasonCode)) {
    throw new Error("IMAGE_EFFECT_USAGE_FACT_INVALID");
  }
}

export function imageEffectUsageFactDigest(fact: ImageEffectUsageFact): string {
  const dimensions = [...fact.dimensions]
    .map((dimension) => Object.freeze({ dimensionKey: dimension.dimensionKey,
      sourceUnit: dimension.sourceUnit, quantity: dimension.quantity.toString() }))
    .sort((left, right) => compareCodeUnits(left.dimensionKey, right.dimensionKey) ||
      compareCodeUnits(left.sourceUnit, right.sourceUnit));
  const canonical = JSON.stringify({ evidenceKind: fact.evidenceKind, dimensions,
    attemptOutcome: fact.attemptOutcome, occurredAt: fact.occurredAt, sourceDigest: fact.sourceDigest,
    unavailableReasonCode: fact.unavailableReasonCode ?? null });
  return createHash("sha256").update("kokoro.platform.image-effect-usage-fact.v1\0")
    .update(canonical).digest("hex");
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function usageKey(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(value)) {
    throw new Error("IMAGE_EFFECT_USAGE_FACT_INVALID");
  }
}

function snapshotOutputs(outputs: readonly ImageEffectProviderOutput[]): readonly ImageEffectOutputEvidence[] {
  const candidates = new Set<string>();
  const slots = new Set<string>();
  return Object.freeze(outputs.map((output) => {
    reference(output.candidateRef);
    reference(output.stableOutputSlotRef);
    reference(output.providerOutputFactRef);
    if (!["image/png", "image/jpeg", "image/webp"].includes(output.mediaType) ||
        !Number.isInteger(output.width) || output.width < 1 || output.width > 65_535 ||
        !Number.isInteger(output.height) || output.height < 1 || output.height > 65_535 ||
        (output.declaredByteSize !== undefined && output.declaredByteSize < 1n)) {
      throw new Error("IMAGE_EFFECT_OUTPUT_EVIDENCE_INVALID");
    }
    if (output.retrievalGrantHandle.length < 32 || output.retrievalGrantHandle.length > 8192 ||
        /[\0\r\n]/u.test(output.retrievalGrantHandle) || candidates.has(output.candidateRef) ||
        slots.has(output.stableOutputSlotRef)) {
      throw new Error("IMAGE_EFFECT_OUTPUT_EVIDENCE_INVALID");
    }
    candidates.add(output.candidateRef);
    slots.add(output.stableOutputSlotRef);
    return Object.freeze({
      candidateRef: output.candidateRef,
      stableOutputSlotRef: output.stableOutputSlotRef,
      providerOutputFactRef: output.providerOutputFactRef,
      retrievalGrantHandleDigest: createHash("sha256").update(output.retrievalGrantHandle, "utf8").digest("hex"),
    });
  }));
}

function isTerminal(state: ImageEffectAttemptState): boolean {
  return state === "definitely_not_submitted" || state === "succeeded" || state === "failed" ||
    state === "canceled" || state === "outcome_unknown";
}

function positiveOrdinal(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 64) throw new Error("IMAGE_EFFECT_ATTEMPT_ORDINAL_INVALID");
}

function reference(value: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || /[\0\r\n]/u.test(value)) {
    throw new Error("IMAGE_EFFECT_REFERENCE_INVALID");
  }
}

function digest(value: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error("IMAGE_EFFECT_DIGEST_INVALID");
}

function instant(value: string): void {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error("IMAGE_EFFECT_INSTANT_INVALID");
  }
}
