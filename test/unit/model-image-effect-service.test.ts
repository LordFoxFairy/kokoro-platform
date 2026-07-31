import { describe, expect, it, vi } from "vitest";
import {
  ImageEffectService,
  type ImageEffectAccessAuthorization,
  type ImageEffectBudgetCommitAuthority,
  type CreateImageEffectCommand,
  type ImageEffectCommandJournal,
  type ImageEffectInvocation,
  type ImageEffectRepository,
  type ImageEffectUnitOfWork,
} from "../../src/modules/model-gateway/application/image-effect-service.js";
import { createGeneratedImageEffectCommandDigestAuthority } from
  "../../src/modules/model-gateway/interfaces/connect/image-effect-connect-service.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const HANDLE = "h".repeat(32);
const ROTATED_HANDLE = "x".repeat(32);
const MODEL_HANDLE = "m".repeat(32);
const DIGEST_AUTHORITY = createGeneratedImageEffectCommandDigestAuthority();
const ATTEMPT_AUTHORIZATION_REF = "00000000-0000-7000-8000-000000000111";
const ATTEMPT_AUTHORIZATION_DIGEST = "7".repeat(64);

describe("ImageEffectService", () => {
  it("commits the exact budget before persisting a provider-dispatchable attempt and replays without a second commit", async () => {
    const events: string[] = [];
    const repository = new MemoryRepository(events);
    const budget: ImageEffectBudgetCommitAuthority = {
      consume: vi.fn(async (_transaction, input) => {
        events.push("budget.consume");
        return { kind: "accepted", effectBudgetCommitRef: input.effectBudgetCommitRef,
          effectBudgetCommitDigest: input.effectBudgetCommitDigest, attemptOrdinal: input.attemptOrdinal,
          attemptAuthorizationRef: ATTEMPT_AUTHORIZATION_REF, attemptAuthorizationFenceEpoch: 1n,
          attemptAuthorizationDigest: ATTEMPT_AUTHORIZATION_DIGEST,
          expiresAt: "2026-08-01T12:00:00.000Z" } as const;
      }),
    };
    const service = serviceWith(repository, budget);
    const first = await service.create(createCommand());
    expect(first.replayed).toBe(false);
    expect(first.invocation.currentAttemptOrdinal).toBe(1);
    expect(first.invocation.state).toBe("accepted");
    expect(first.invocation).toMatchObject({ attemptAuthorizationRef: ATTEMPT_AUTHORIZATION_REF,
      attemptAuthorizationFenceEpoch: 1n, attemptAuthorizationDigest: ATTEMPT_AUTHORIZATION_DIGEST });
    expect(first.receipt.requestDigest).toBe(createCommand().callerRequestFingerprint);
    expect(first.receipt.receiptRef).toBe(`image-effect-receipt:sha256:${first.receipt.receiptDigest}`);
    expect(events).toEqual(["budget.consume", "repository.create"]);

    const replay = await service.create(createCommand());
    expect(replay).toEqual({ ...first, replayed: true });
    expect(budget.consume).toHaveBeenCalledTimes(1);
  });

  it("rejects a changed owner digest before budget consumption", async () => {
    const repository = new MemoryRepository([]);
    const budget: ImageEffectBudgetCommitAuthority = { consume: vi.fn(async (_transaction, input) => ({
      kind: "accepted" as const,
      effectBudgetCommitRef: input.effectBudgetCommitRef,
      effectBudgetCommitDigest: input.effectBudgetCommitDigest,
      attemptOrdinal: input.attemptOrdinal,
      attemptAuthorizationRef: ATTEMPT_AUTHORIZATION_REF, attemptAuthorizationFenceEpoch: 1n,
      attemptAuthorizationDigest: ATTEMPT_AUTHORIZATION_DIGEST,
      expiresAt: "2026-08-01T12:00:00.000Z",
    })) };
    const service = serviceWith(repository, budget);
    await service.create(createCommand());
    await expect(service.create(createCommand({ operationInputRevisionRef: "input-revision:two" })))
      .rejects.toThrow("IMAGE_EFFECT_IDEMPOTENCY_CONFLICT");
    expect(budget.consume).toHaveBeenCalledTimes(1);
  });

  it("replays the same effect after bearer rotation because owner identity is stable", async () => {
    const repository = new MemoryRepository([]);
    const budget: ImageEffectBudgetCommitAuthority = { consume: vi.fn(async (_transaction, input) => ({
      kind: "accepted" as const,
      effectBudgetCommitRef: input.effectBudgetCommitRef,
      effectBudgetCommitDigest: input.effectBudgetCommitDigest,
      attemptOrdinal: input.attemptOrdinal,
      attemptAuthorizationRef: ATTEMPT_AUTHORIZATION_REF, attemptAuthorizationFenceEpoch: 1n,
      attemptAuthorizationDigest: ATTEMPT_AUTHORIZATION_DIGEST,
      expiresAt: "2026-08-01T12:00:00.000Z",
    })) };
    const service = serviceWith(repository, budget);
    const first = await service.create(createCommand());
    const replay = await service.create({ ...createCommand(), callerAccessHandle: ROTATED_HANDLE });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(budget.consume).toHaveBeenCalledTimes(1);
  });

  it("attaches the next budget only with exact definitely-not-submitted evidence and a continuous ordinal", async () => {
    const repository = new MemoryRepository([]);
    const budget: ImageEffectBudgetCommitAuthority = { consume: vi.fn(async (_transaction, input) => ({
      kind: "accepted" as const,
      effectBudgetCommitRef: input.effectBudgetCommitRef,
      effectBudgetCommitDigest: input.effectBudgetCommitDigest,
      attemptOrdinal: input.attemptOrdinal,
      attemptAuthorizationRef: ATTEMPT_AUTHORIZATION_REF, attemptAuthorizationFenceEpoch: 1n,
      attemptAuthorizationDigest: ATTEMPT_AUTHORIZATION_DIGEST,
      expiresAt: "2026-08-01T12:00:00.000Z",
    })) };
    const service = serviceWith(repository, budget, (scope) => authorizationFor(
      scope.callerAccessHandle,
      scope.operation === "attach" ? "changed-option:must-not-win" : "image-option:revision:one",
      scope.operation === "attach" ? "changed-deployment:must-not-win" : "deployment:image:one",
    ));
    const created = await service.create(createCommand());
    repository.makeDefinitelyNotSubmitted(created.invocation.logicalInvocationRef,
      "not-submitted-receipt:one", DIGEST_B);

    const attachEffect = {
      callerAccessHandle: HANDLE,
      attemptAuthorizationCommandRef: "attach-command:two",
      modelInvocationCommandRef: "model-command:one",
      logicalInvocationRef: created.invocation.logicalInvocationRef,
      definitelyNotSubmittedReceiptRef: "not-submitted-receipt:one",
      definitelyNotSubmittedReceiptDigest: DIGEST_B,
      nextAttemptOrdinal: 2,
      effectBudgetCommitRef: "budget-commit:two",
      effectBudgetCommitDigest: DIGEST_A,
    };
    const attached = await service.attachNextAttemptAuthorization({ ...attachEffect,
      callerRequestFingerprint: DIGEST_AUTHORITY.attach(attachEffect, authorizationFor(HANDLE)) });
    expect(attached.invocation.currentAttemptOrdinal).toBe(2);
    expect(attached.invocation.state).toBe("accepted");
    expect(budget.consume).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      modelOptionRevisionRef: "image-option:revision:one",
      deploymentRef: "deployment:image:one",
    }));

    const unsafeAttachEffect = {
      callerAccessHandle: HANDLE,
      attemptAuthorizationCommandRef: "attach-command:three",
      modelInvocationCommandRef: "model-command:one",
      logicalInvocationRef: created.invocation.logicalInvocationRef,
      definitelyNotSubmittedReceiptRef: "not-submitted-receipt:wrong",
      definitelyNotSubmittedReceiptDigest: DIGEST_B,
      nextAttemptOrdinal: 3,
      effectBudgetCommitRef: "budget-commit:three",
      effectBudgetCommitDigest: DIGEST_A,
    };
    await expect(service.attachNextAttemptAuthorization({ ...unsafeAttachEffect,
      callerRequestFingerprint: DIGEST_AUTHORITY.attach(unsafeAttachEffect, authorizationFor(HANDLE)) }))
      .rejects.toThrow("IMAGE_EFFECT_PREVIOUS_ATTEMPT_NOT_SAFE");
  });

  it("journals cancellation intent with an exact owner-version fence without reporting provider cancellation", async () => {
    const repository = new MemoryRepository([]);
    const service = serviceWith(repository, { consume: async (_transaction, input) => ({
      kind: "accepted", effectBudgetCommitRef: input.effectBudgetCommitRef,
      effectBudgetCommitDigest: input.effectBudgetCommitDigest, attemptOrdinal: input.attemptOrdinal,
      attemptAuthorizationRef: ATTEMPT_AUTHORIZATION_REF, attemptAuthorizationFenceEpoch: 1n,
      attemptAuthorizationDigest: ATTEMPT_AUTHORIZATION_DIGEST,
      expiresAt: "2026-08-01T12:00:00.000Z",
    }) });
    const created = await service.create(createCommand());
    const cancelEffect = {
      callerAccessHandle: HANDLE,
      cancelCommandRef: "cancel-command:one",
      logicalInvocationRef: created.invocation.logicalInvocationRef,
      expectedInvocationVersion: created.invocation.ownerVersion,
    };
    const canceled = await service.requestCancel({ ...cancelEffect,
      callerRequestFingerprint: DIGEST_AUTHORITY.cancel(cancelEffect, authorizationFor(HANDLE)) });
    expect(canceled.invocation.state).toBe("cancel_requested");
    expect(canceled.invocation.ownerVersion).toBe(created.invocation.ownerVersion + 1n);
  });

  it("refuses to recover a journal whose persisted canonical receipt identity was altered", async () => {
    const repository = new MemoryRepository([]);
    const service = serviceWith(repository, { consume: async (_transaction, input) => ({
      kind: "accepted", effectBudgetCommitRef: input.effectBudgetCommitRef,
      effectBudgetCommitDigest: input.effectBudgetCommitDigest, attemptOrdinal: input.attemptOrdinal,
      attemptAuthorizationRef: ATTEMPT_AUTHORIZATION_REF, attemptAuthorizationFenceEpoch: 1n,
      attemptAuthorizationDigest: ATTEMPT_AUTHORIZATION_DIGEST,
      expiresAt: "2026-08-01T12:00:00.000Z",
    }) });
    await service.create(createCommand());
    repository.corruptReceipt("model-command:one");
    await expect(service.recover({ callerAccessHandle: HANDLE, callerCommandRef: "model-command:one" }))
      .rejects.toThrow("IMAGE_EFFECT_RECEIPT_INTEGRITY_INVALID");
  });
});

function createCommand(overrides: Partial<CreateImageEffectCommand> = {}): CreateImageEffectCommand {
  const command = Object.freeze({
    callerAccessHandle: HANDLE,
    modelInvocationCommandRef: "model-command:one",
    callerRequestFingerprint: DIGEST_A,
    definitionRoleRef: "image.text_to_image.v1",
    modelOptionAuthorizationHandle: MODEL_HANDLE,
    modelOptionRevisionRef: "image-option:revision:one",
    operationInputRevisionRef: "input-revision:one",
    operationInputRevisionDigest: DIGEST_B,
    sourceGrants: Object.freeze([]),
    logicalOutputSlots: Object.freeze([{ candidateRef: "candidate:one", stableOutputSlotRef: "slot:one" }]),
    effectBudgetCommitRef: "budget-commit:one",
    effectBudgetCommitDigest: DIGEST_A,
    attemptOrdinal: 1 as const,
    trustEffectAllowReceiptRef: "trust-allow:one",
    trustEffectAllowReceiptDigest: DIGEST_B,
    ...overrides,
  });
  return Object.freeze({ ...command,
    callerRequestFingerprint: DIGEST_AUTHORITY.create(command, authorizationFor(command.callerAccessHandle)) });
}

function serviceWith(
  repository: ImageEffectRepository,
  budget: ImageEffectBudgetCommitAuthority,
  resolveAuthorization: (scope: Parameters<ImageEffectUnitOfWork["execute"]>[0]) =>
    ImageEffectAccessAuthorization = (scope) => authorizationFor(scope.callerAccessHandle),
) {
  const unitOfWork: ImageEffectUnitOfWork = {
    execute: async (scope, work) => work({} as never, resolveAuthorization(scope)),
  };
  let reference = 0;
  return new ImageEffectService({ unitOfWork, repository, budget,
    commandDigest: createGeneratedImageEffectCommandDigestAuthority(),
    clock: () => new Date("2026-07-31T12:00:00.000Z"),
    reference: (kind) => `${kind}:${++reference}` });
}

function authorizationFor(
  handle: string,
  modelOptionRevisionRef = "image-option:revision:one",
  deploymentRef = "deployment:image:one",
): ImageEffectAccessAuthorization {
  const handleDigest = handle === HANDLE
    ? "9432eaeb3d35fc96836055c988e45bd07ef2ef9f63c88f8f3f22f5287a4cb32a"
    : "c62e4615bd39e222572f3a1bf7c2132ea1e65b17ec805047bd6b2842c593493f";
  return Object.freeze({
    callerAccessHandleDigest: handleDigest,
    callerIdentity: "platform-media-worker:one",
    siteId: "site:one",
    callerAudience: "platform-media-worker",
    workloadIdentityRef: "spiffe://kokoro/platform-media-worker",
    environment: "test",
    region: "local",
    authorizationGeneration: 7n,
    securityEpoch: 11n,
    accessExpiresAt: "2026-08-01T12:00:00.000Z",
    sourceGrantClaims: Object.freeze([]),
    modelOption: Object.freeze({
      authorizationHandleDigest: "0c0524a72a27631c8da35155361d40ccaa627803afa39b78a0bcf666d25456c8",
      modelOptionRevisionRef,
      definitionRoleRef: "image.text_to_image.v1",
      deploymentRef,
      adapterKind: "certified-image-v1",
      providerModel: "image-model-one",
      expiresAt: "2026-08-01T12:00:00.000Z",
    }),
  });
}

class MemoryRepository implements ImageEffectRepository {
  readonly #journals = new Map<string, ImageEffectCommandJournal>();
  readonly #invocations = new Map<string, ImageEffectInvocation>();
  constructor(private readonly events: string[]) {}
  async lockCommand(_transaction: never, input: { callerIdentity: string; callerCommandRef: string }) {
    return this.#journals.get(`${input.callerIdentity}\0${input.callerCommandRef}`) ?? null;
  }
  async lockInvocation(_transaction: never, input: { callerIdentity: string; logicalInvocationRef?: string;
    modelInvocationCommandRef?: string }) {
    return [...this.#invocations.values()].find((item) => item.callerIdentity === input.callerIdentity &&
      (input.logicalInvocationRef === undefined || item.logicalInvocationRef === input.logicalInvocationRef) &&
      (input.modelInvocationCommandRef === undefined ||
        item.modelInvocationCommandRef === input.modelInvocationCommandRef)) ?? null;
  }
  async create(_transaction: never, input: { journal: ImageEffectCommandJournal;
    invocation: ImageEffectInvocation;
    sourceGrants: readonly Readonly<{ sourceVersionRef: string; purposeGrantHandle: string }>[] }) {
    this.events.push("repository.create");
    this.#journals.set(`${input.journal.callerIdentity}\0${input.journal.callerCommandRef}`, input.journal);
    this.#invocations.set(input.invocation.logicalInvocationRef, input.invocation);
  }
  async persistCommand(_transaction: never, input: { journal: ImageEffectCommandJournal;
    invocation: ImageEffectInvocation }) {
    this.#journals.set(`${input.journal.callerIdentity}\0${input.journal.callerCommandRef}`, input.journal);
    this.#invocations.set(input.invocation.logicalInvocationRef, input.invocation);
  }
  makeDefinitelyNotSubmitted(logicalInvocationRef: string, receiptRef: string, receiptDigest: string) {
    const invocation = this.#invocations.get(logicalInvocationRef)!;
    const attempt = invocation.attempts.at(-1)!;
    this.#invocations.set(logicalInvocationRef, Object.freeze({ ...invocation,
      state: "definitely_not_submitted" as const,
      attempts: Object.freeze([{ ...attempt, state: "definitely_not_submitted" as const,
        definitelyNotSubmittedReceiptRef: receiptRef,
        definitelyNotSubmittedReceiptDigest: receiptDigest }]) }));
  }
  corruptReceipt(callerCommandRef: string) {
    const key = `platform-media-worker:one\0${callerCommandRef}`;
    const journal = this.#journals.get(key)!;
    this.#journals.set(key, Object.freeze({ ...journal,
      receipt: Object.freeze({ ...journal.receipt, receiptDigest: DIGEST_A }) }));
  }
}
