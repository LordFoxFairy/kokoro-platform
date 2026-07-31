import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalMediaOperationInputV1Bytes } from
  "../../src/interfaces/http/generated/platform-public/media-canonical.js";
import {
  EnvelopeOperationInputProtector,
  type MediaOperationOwnerBinding,
} from "../../src/modules/media/application/operation-input-protection.js";
import {
  PostgresMediaImageWorkerRepository,
  type MediaImageCapabilityOpener,
  type MediaImageWorkerDatabase,
  type MediaImageWorkerTaskRow,
} from "../../src/modules/media/infrastructure/postgres/media-image-worker-repository.js";

const key = new Uint8Array(32).fill(7);
const binding: MediaOperationOwnerBinding = Object.freeze({ siteRef: "site:one", subjectRef: "subject:one",
  subjectGeneration: 1n, projectRef: "project:one", workloadRef: "run:one", source: "agent_runtime",
  definitionRevisionRef: "image.text_to_image@v1:revision:1",
  modelOptionRevisionRef: "image-option:revision:1" });
const request = Object.freeze({ contractMajor: 1 as const, definitionRevisionRef: binding.definitionRevisionRef,
  kind: "image_text_to_image" as const, promptIntent: "silver fox", aspectRatio: "square_1_1" as const,
  candidateCount: 1 as const, modelOptionRevisionRef: binding.modelOptionRevisionRef,
  outputFormat: "png" as const });
const callerHandle = new TextEncoder().encode("caller-access-secret-handle");
const modelHandle = new TextEncoder().encode("model-option-secret-handle");
const opener: MediaImageCapabilityOpener = { open: (input) =>
  input.purpose.endsWith("caller-access") ? new Uint8Array(callerHandle) : new Uint8Array(modelHandle) };

function taskRow(): MediaImageWorkerTaskRow {
  const protectedInput = new EnvelopeOperationInputProtector({ activeKey: {
    keyRevisionRef: "media-kek:one", key,
  } }).protect({ operationInputRevisionRef: "media-input:one", ownerBinding: binding,
    canonicalBytes: canonicalMediaOperationInputV1Bytes(request) });
  return {
    taskRef: "media-dispatch:one", operationRef: "media-operation:one", leaseEpoch: "3",
    operationState: "queued", cancelIntentReceiptRef: null,
    modelInvocationCommandRef: "model-command:one", creditChildAllocationRef: "00000000-0000-7000-8000-000000000001",
    effectBudgetCommitRef: "effect-budget-commit:one", effectBudgetCommitDigest: "d".repeat(64),
    attemptOrdinal: 1, gatewayCallerRequestFingerprint: "a".repeat(64),
    gatewayCreateEffectDigest: "a".repeat(64), definitionRoleRef: "image-role:one",
    operationInputRevisionDigest: "c".repeat(64), trustEffectAllowReceiptRef: "trust-effect-allow:one",
    trustEffectAllowReceiptDigest: "e".repeat(64), sourceGrants: [],
    callerAccessCapabilityEnvelope: { ciphertext: "sealed-caller" },
    callerAccessHandleDigest: createHash("sha256").update(callerHandle).digest("hex"),
    callerAccessExpiresAt: "2099-01-01T00:00:00.000Z", callerAccessBindingRef: "caller-binding:one",
    modelOptionAuthorizationCapabilityEnvelope: { ciphertext: "sealed-model" },
    modelOptionAuthorizationHandleDigest: createHash("sha256").update(modelHandle).digest("hex"),
    modelOptionAuthorizationExpiresAt: "2099-01-01T00:00:00.000Z",
    modelOptionAuthorizationBindingRef: "model-binding:one",
    siteRef: binding.siteRef, subjectRef: binding.subjectRef, subjectGeneration: "1",
    projectRef: binding.projectRef, workloadRef: binding.workloadRef, source: binding.source,
    definitionRevisionRef: binding.definitionRevisionRef,
    modelOptionRevisionRef: binding.modelOptionRevisionRef,
    operationInputRevisionRef: protectedInput.operationInputRevisionRef,
    keyRevisionRef: protectedInput.keyRevisionRef,
    ciphertext: Buffer.from(protectedInput.ciphertextBase64, "base64"),
    contentIv: Buffer.from(protectedInput.contentIvBase64, "base64"),
    contentTag: Buffer.from(protectedInput.contentTagBase64, "base64"),
    wrappedDek: Buffer.from(protectedInput.wrappedDekBase64, "base64"),
    wrapIv: Buffer.from(protectedInput.wrapIvBase64, "base64"),
    wrapTag: Buffer.from(protectedInput.wrapTagBase64, "base64"),
    plaintextBytes: protectedInput.plaintextBytes,
    candidates: [{ candidateRef: "candidate:one", stableOutputSlotRef: "image-slot:one", artifactRef: "artifact:one",
      artifactVersionRef: "artifact-version:one", outputAccessCommandRef: "output-access-command:one",
      outputAccessRequestFingerprint: "f".repeat(64), ordinal: 1 }],
    cancelCommandRef: null, cancelRequestFingerprint: null,
    sagaCheckpoint: { effectState: "none", cancelState: "none",
      definitionPolicy: { partialCompletion: "forbidden", minimumReadyCandidates: 1 },
      evidence: { nextEvidenceSequence: "0", caughtUp: false, facts: [] },
      artifacts: [{ candidateOrdinal: 1 }] },
  };
}

class FakeDatabase implements MediaImageWorkerDatabase {
  readonly calls: Array<{ operation: string; input: Readonly<Record<string, unknown>> }> = [];
  claimResult: readonly MediaImageWorkerTaskRow[] = [taskRow()];
  retryResult: "retry" | "dead_letter" = "retry";

  claim(input: Parameters<MediaImageWorkerDatabase["claim"]>[0]) { this.record("claim", input); return Promise.resolve(this.claimResult); }
  renew(input: Parameters<MediaImageWorkerDatabase["renew"]>[0]) { this.record("renew", input); return Promise.resolve(); }
  prepareEffect(input: Parameters<MediaImageWorkerDatabase["prepareEffect"]>[0]) { this.record("prepareEffect", input);
    return Promise.resolve([{ requestDigest: input.requestDigest, state: "started" as const,
      ownerResult: null, created: true }]); }
  recordEffectView(input: Parameters<MediaImageWorkerDatabase["recordEffectView"]>[0]) { this.record("recordEffectView", input); return Promise.resolve({ lateCancellationObserved: false }); }
  recordOwnerView(input: Parameters<MediaImageWorkerDatabase["recordOwnerView"]>[0]) { this.record("recordOwnerView", input); return Promise.resolve({ lateCancellationObserved: false }); }
  recordEvidencePage(input: Parameters<MediaImageWorkerDatabase["recordEvidencePage"]>[0]) {
    this.record("recordEvidencePage", input); return Promise.resolve([{ evidenceCheckpoint: {
      logicalInvocationRef: input.logicalInvocationRef,
      nextEvidenceSequence: input.nextEvidenceSequence.toString(), caughtUp: input.caughtUp, facts: input.facts,
    } }]); }
  prepareCancel(input: Parameters<MediaImageWorkerDatabase["prepareCancel"]>[0]) {
    this.record("prepareCancel", input); return Promise.resolve([{ requestDigest: input.requestDigest,
      state: "started" as const, ownerResult: null, created: true }]); }
  recordCancelResult(input: Parameters<MediaImageWorkerDatabase["recordCancelResult"]>[0]) {
    this.record("recordCancelResult", input); return Promise.resolve(); }
  recordCancelOutcomeUnknown(input: Parameters<MediaImageWorkerDatabase["recordCancelOutcomeUnknown"]>[0]) {
    this.record("recordCancelOutcomeUnknown", input); return Promise.resolve(); }
  recordOutcomeUnknown(input: Parameters<MediaImageWorkerDatabase["recordOutcomeUnknown"]>[0]) { this.record("recordOutcomeUnknown", input); return Promise.resolve(); }
  recordSagaReceipt(input: Parameters<MediaImageWorkerDatabase["recordSagaReceipt"]>[0]) { this.record("recordSagaReceipt", input); return Promise.resolve(); }
  complete(input: Parameters<MediaImageWorkerDatabase["complete"]>[0]) { this.record("complete", input); return Promise.resolve(); }
  retryOrDeadLetter(input: Parameters<MediaImageWorkerDatabase["retryOrDeadLetter"]>[0]) { this.record("retryOrDeadLetter", input); return Promise.resolve(this.retryResult); }
  releaseOwnedLeases(input: Parameters<MediaImageWorkerDatabase["releaseOwnedLeases"]>[0]) { this.record("releaseOwnedLeases", input); return Promise.resolve(); }
  private record(operation: string, input: Readonly<Record<string, unknown>>) { this.calls.push({ operation, input }); }
}

describe("Postgres Media image worker repository", () => {
  it("claims with a hashed lease capability and opens the exact owner-bound canonical input", async () => {
    const database = new FakeDatabase();
    const repository = new PostgresMediaImageWorkerRepository({ database,
      inputProtector: new EnvelopeOperationInputProtector({ activeKey: { keyRevisionRef: "media-kek:one", key } }),
      capabilityOpener: opener,
      leaseToken: () => "lease-token-that-never-enters-postgres" });

    const task = await repository.claim({ workerId: "worker:one", now: "2026-07-31T00:00:00.000Z", leaseMs: 30_000 });

    expect(task).toMatchObject({ taskRef: "media-dispatch:one", operationRef: "media-operation:one",
      leaseEpoch: 3n, leaseToken: "lease-token-that-never-enters-postgres", request: {
        promptIntent: "silver fox", candidateCount: 1, outputFormat: "png",
      }, definitionPolicy: { partialCompletion: "forbidden", minimumReadyCandidates: 1 },
      createEffectCommand: { effectBudgetCommitRef: "effect-budget-commit:one", attemptOrdinal: 1,
        callerRequestFingerprint: "a".repeat(64), createEffectDigest: "a".repeat(64) } });
    expect(database.calls[0]?.input).toMatchObject({ workerId: "worker:one", leaseSeconds: 30,
      leaseTokenHash: createHash("sha256").update("lease-token-that-never-enters-postgres").digest("hex") });
    expect(JSON.stringify(database.calls[0])).not.toContain("lease-token-that-never-enters-postgres");
  });

  it("passes only the task fence and hashed lease capability to every owner mutation", async () => {
    const database = new FakeDatabase();
    const repository = new PostgresMediaImageWorkerRepository({ database,
      inputProtector: new EnvelopeOperationInputProtector({ activeKey: { keyRevisionRef: "media-kek:one", key } }),
      capabilityOpener: opener,
      leaseToken: () => "lease-token-that-never-enters-postgres" });
    const task = (await repository.claim({ workerId: "worker:one", now: "2026-07-31T00:00:00.000Z",
      leaseMs: 30_000 }))!;

    await repository.renewLease(task, 30_000);
    await repository.recordOutcomeUnknown(task, { errorCode: "PROVIDER_TIMEOUT",
      observedAt: "2026-07-31T00:00:01.000Z" });
    expect(database.calls.slice(1).every((call) => call.input.leaseTokenHash ===
      createHash("sha256").update(task.leaseToken).digest("hex"))).toBe(true);
    expect(JSON.stringify(database.calls, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value)).not.toContain(task.leaseToken);
  });

  it("fails closed when the encrypted input does not match frozen owner/model facts", async () => {
    const database = new FakeDatabase();
    database.claimResult = [{ ...taskRow(), modelOptionRevisionRef: "image-option:revision:other" }];
    const repository = new PostgresMediaImageWorkerRepository({ database,
      inputProtector: new EnvelopeOperationInputProtector({ activeKey: { keyRevisionRef: "media-kek:one", key } }),
      capabilityOpener: opener,
      leaseToken: () => "lease-token-that-never-enters-postgres" });

    await expect(repository.claim({ workerId: "worker:one", now: "2026-07-31T00:00:00.000Z",
      leaseMs: 30_000 })).rejects.toThrow("MEDIA_INPUT_AUTHENTICATION_FAILED");
  });

  it("rejects Direct Studio rows until the worker projection carries its complete authority fence", async () => {
    const database = new FakeDatabase();
    database.claimResult = [{ ...taskRow(), source: "direct_studio" }];
    const repository = new PostgresMediaImageWorkerRepository({ database,
      inputProtector: new EnvelopeOperationInputProtector({ activeKey: { keyRevisionRef: "media-kek:one", key } }),
      capabilityOpener: opener,
      leaseToken: () => "lease-token-that-never-enters-postgres" });

    await expect(repository.claim({ workerId: "worker:one", now: "2026-07-31T00:00:00.000Z",
      leaseMs: 30_000 })).rejects.toThrow("MEDIA_WORKER_OWNER_BINDING_UNSUPPORTED");
  });

  it("fails closed when the owner-frozen Definition policy is absent", async () => {
    const database = new FakeDatabase();
    const row = taskRow();
    database.claimResult = [{ ...row, sagaCheckpoint: {
      ...(row.sagaCheckpoint as Record<string, unknown>), definitionPolicy: undefined,
    } }];
    const repository = new PostgresMediaImageWorkerRepository({ database,
      inputProtector: new EnvelopeOperationInputProtector({ activeKey: { keyRevisionRef: "media-kek:one", key } }),
      capabilityOpener: opener,
      leaseToken: () => "lease-token-that-never-enters-postgres" });

    await expect(repository.claim({ workerId: "worker:one", now: "2026-07-31T00:00:00.000Z",
      leaseMs: 30_000 })).rejects.toThrow("MEDIA_DEFINITION_POLICY_INVALID");
  });
});
