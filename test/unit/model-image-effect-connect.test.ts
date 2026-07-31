import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import { CreateImageEffectRequestSchema, ImageEffectReceiptKind, ImageEffectState } from
  "../../src/interfaces/connect/generated-model-image-effect/kokoro/platform/model/image/v1/image_effect_pb.js";
import { createGeneratedImageEffectCommandDigestAuthority, createImageEffectConnectService } from
  "../../src/modules/model-gateway/interfaces/connect/image-effect-connect-service.js";
import type { CreateImageEffectCommand, ImageEffectAccessAuthorization } from
  "../../src/modules/model-gateway/application/image-effect-service.js";
import { assertImageEffectProductionReadiness } from
  "../../src/process/model-gateway-composition.js";

const RESULT = Object.freeze({
  receipt: Object.freeze({ callerCommandRef: "command:one", kind: "create_committed" as const,
    logicalInvocationRef: "invocation:one", attemptRef: "attempt:one", attemptOrdinal: 1,
    receiptVersion: 1n, recordedAt: "2026-07-31T12:00:00.000Z", requestDigest: "a".repeat(64),
    receiptRef: `image-effect-receipt:sha256:${"b".repeat(64)}`, receiptDigest: "b".repeat(64) }),
  invocation: Object.freeze({ logicalInvocationRef: "invocation:one", modelInvocationCommandRef: "command:one",
    ownerVersion: 1n, currentAttemptOrdinal: 1, state: "accepted" as const,
    attemptAuthorizationRef: "00000000-0000-7000-8000-000000000111",
    attemptAuthorizationFenceEpoch: 1n,
    attemptAuthorizationDigest: "7".repeat(64),
    observedAt: "2026-07-31T12:00:00.000Z" }),
  replayed: false,
});

describe("image-effect Connect provider", () => {
  it("fails production startup closed until Root publishes the required effect authorities", () => {
    expect(() => assertImageEffectProductionReadiness({ PLATFORM_MODEL_IMAGE_EFFECT_ENABLED: "true" }))
      .toThrow("PLATFORM_MODEL_IMAGE_EFFECT_ACTIVATION_INCOMPLETE");
    expect(() => assertImageEffectProductionReadiness({ PLATFORM_MODEL_IMAGE_EFFECT_ENABLED: "false" }))
      .not.toThrow();
  });

  it("authorizes the Media workload and maps the stable model-option claim", async () => {
    const createEffect = vi.fn(async () => RESULT);
    const service = createImageEffectConnectService({
      application: {
        create: createEffect,
        recover: vi.fn(),
        get: vi.fn(),
        requestCancel: vi.fn(),
        attachNextAttemptAuthorization: vi.fn(),
      },
      caller: { resolve: () => ({ identity: "spiffe://kokoro/platform-media-worker" }) },
      mediaCallerIdentity: "spiffe://kokoro/platform-media-worker",
    });
    const request = create(CreateImageEffectRequestSchema, {
      callerAccessHandle: "h".repeat(32), modelInvocationCommandRef: "command:one",
      callerRequestFingerprint: "b".repeat(64), definitionRoleRef: "image.text_to_image.v1",
      modelOptionAuthorizationHandle: "m".repeat(32), operationInputRevisionRef: "input:one",
      modelOptionRevisionRef: "image-option:one",
      operationInputRevisionDigest: "c".repeat(64), sourceGrants: [],
      logicalOutputSlots: [{ candidateRef: "candidate:one", stableOutputSlotRef: "slot:one" }],
      effectBudgetCommitRef: "budget:one", effectBudgetCommitDigest: "d".repeat(64), attemptOrdinal: 1,
      trustEffectAllowReceiptRef: "trust:one", trustEffectAllowReceiptDigest: "e".repeat(64),
    });
    const response = await service.createImageEffect(request, {} as never);
    expect(createEffect).toHaveBeenCalledWith(expect.objectContaining({ modelOptionRevisionRef: "image-option:one" }));
    expect(response.invocation?.state).toBe(ImageEffectState.ACCEPTED);
  });

  it("rejects any peer other than the exact configured Media identity", async () => {
    const service = createImageEffectConnectService({
      application: { create: vi.fn(), recover: vi.fn(), get: vi.fn(), requestCancel: vi.fn(),
        attachNextAttemptAuthorization: vi.fn() },
      caller: { resolve: () => ({ identity: "spiffe://kokoro/agent" }) },
      mediaCallerIdentity: "spiffe://kokoro/platform-media-worker",
    });
    await expect(service.getImageEffectByCommand({ callerAccessHandle: "h".repeat(32),
      modelInvocationCommandRef: "command:one" } as never, {} as never))
      .rejects.toMatchObject({ code: Code.PermissionDenied } satisfies Partial<ConnectError>);
  });

  it("uses the Root-generated known-field helper after verified authority and ignores bearer rotation", () => {
    const digest = createGeneratedImageEffectCommandDigestAuthority();
    const command = effectCommand();
    const authorization = effectAuthorization();
    expect(digest.create(command, authorization)).toBe(
      digest.create({ ...command, callerAccessHandle: "x".repeat(32),
        modelOptionAuthorizationHandle: "y".repeat(32),
        sourceGrants: [{ sourceVersionRef: "source:one", purposeGrantHandle: "z".repeat(32) }] }, authorization),
    );
    expect(digest.create({ ...command, modelOptionRevisionRef: "option:two" }, authorization))
      .not.toBe(digest.create(command, authorization));
  });

  it("keeps evidence and output-access RPCs authenticated and explicitly fail-closed", async () => {
    const service = createImageEffectConnectService({
      application: { create: vi.fn(), recover: vi.fn(), get: vi.fn(), requestCancel: vi.fn(),
        attachNextAttemptAuthorization: vi.fn() },
      caller: { resolve: () => ({ identity: "spiffe://kokoro/platform-media-worker" }) },
      mediaCallerIdentity: "spiffe://kokoro/platform-media-worker",
    });
    for (const call of [
      () => service.getImageEffectEvidence({} as never, {} as never),
      () => service.issueImageEffectOutputAccess({} as never, {} as never),
      () => service.recoverImageEffectOutputAccessByCommand({} as never, {} as never),
    ]) await expect(call()).rejects.toMatchObject({ code: Code.Unimplemented });
    const stream = service.readImageEffectOutput({} as never, {} as never)[Symbol.asyncIterator]();
    await expect(stream.next()).rejects.toMatchObject({ code: Code.Unimplemented });
  });

  it("maps the activated evidence, output capability recovery and bounded stream owner RPCs", async () => {
    const outputResult = Object.freeze({ receipt: Object.freeze({ ...RESULT.receipt,
      kind: "output_access_issued" as const }), outputAccess: Object.freeze({
      outputEvidenceRef: "output:one", outputEvidenceDigest: "c".repeat(64),
      sourceAccessHandle: "kimg1.token", sourceAccessExpiresAt: "2030-01-01T00:00:00.000Z",
      maxReadableBytes: 4096n }), replayed: false });
    const service = createImageEffectConnectService({
      application: { create: vi.fn(), recover: vi.fn(), get: vi.fn(), requestCancel: vi.fn(),
        attachNextAttemptAuthorization: vi.fn() },
      evidence: { get: vi.fn(async () => ({ invocation: RESULT.invocation, evidenceFacts: [],
        nextEvidenceSequence: 0n, caughtUp: true })) },
      output: { issue: vi.fn(async () => outputResult), recover: vi.fn(async () => outputResult),
        read: async function* () { yield { offset: 0n, data: new Uint8Array([1, 2]), nextOffset: 2n,
          eof: true, chunkSha256: "d".repeat(64) }; } },
      caller: { resolve: () => ({ identity: "spiffe://kokoro/platform-media-worker" }) },
      mediaCallerIdentity: "spiffe://kokoro/platform-media-worker",
    });
    const context = { signal: new AbortController().signal } as never;
    expect((await service.getImageEffectEvidence({ callerAccessHandle: "h".repeat(32),
      logicalInvocationRef: "invocation:one", afterEvidenceSequence: 0n, limit: 8 } as never,
    context)).caughtUp).toBe(true);
    const issued = await service.issueImageEffectOutputAccess({ callerAccessHandle: "h".repeat(32),
      outputAccessCommandRef: "output-command:one", logicalInvocationRef: "invocation:one",
      outputEvidenceRef: "output:one", outputEvidenceDigest: "c".repeat(64),
      callerRequestFingerprint: "e".repeat(64) } as never, context);
    expect(issued.receipt?.kind).toBe(ImageEffectReceiptKind.OUTPUT_ACCESS_ISSUED);
    expect(issued.outputAccess?.sourceAccessHandle).toBe("kimg1.token");
    const frames = service.readImageEffectOutput({ sourceAccessHandle: "kimg1.token",
      outputEvidenceRef: "output:one", outputEvidenceDigest: "c".repeat(64), offset: 0n,
      maxBytes: 1024 } as never, context);
    expect((await frames[Symbol.asyncIterator]().next()).value?.nextOffset).toBe(2n);
  });

  it.each([
    ["create_committed", ImageEffectReceiptKind.CREATE_COMMITTED, true],
    ["definitely_not_submitted", ImageEffectReceiptKind.DEFINITELY_NOT_SUBMITTED, true],
    ["attempt_authorization_attached", ImageEffectReceiptKind.ATTEMPT_AUTHORIZATION_ATTACHED, true],
    ["cancel_intent_committed", ImageEffectReceiptKind.CANCEL_INTENT_COMMITTED, true],
    ["rejected", ImageEffectReceiptKind.REJECTED, false],
    ["outcome_unknown", ImageEffectReceiptKind.OUTCOME_UNKNOWN, false],
  ] as const)("maps %s without falling through to output access", async (kind, wireKind, carriesInvocation) => {
    const recover = vi.fn(async () => Object.freeze({ ...RESULT,
      receipt: Object.freeze({ ...RESULT.receipt, kind }) }));
    const service = createImageEffectConnectService({
      application: { create: vi.fn(), recover, get: vi.fn(), requestCancel: vi.fn(),
        attachNextAttemptAuthorization: vi.fn() },
      caller: { resolve: () => ({ identity: "spiffe://kokoro/platform-media-worker" }) },
      mediaCallerIdentity: "spiffe://kokoro/platform-media-worker",
    });
    const response = await service.recoverImageEffectByCommand({ callerAccessHandle: "h".repeat(32),
      callerCommandRef: "command:one" } as never, {} as never);
    expect(response.receipt?.kind).toBe(wireKind);
    expect(response.invocation !== undefined).toBe(carriesInvocation);
  });

  it("fails closed when an output adapter tries to masquerade a command receipt as output access", async () => {
    const malformed = Object.freeze({ receipt: RESULT.receipt, outputAccess: Object.freeze({
      outputEvidenceRef: "output:one", outputEvidenceDigest: "c".repeat(64),
      sourceAccessHandle: "kimg1.token", sourceAccessExpiresAt: "2030-01-01T00:00:00.000Z",
      maxReadableBytes: 4096n }), replayed: false });
    const service = createImageEffectConnectService({
      application: { create: vi.fn(), recover: vi.fn(), get: vi.fn(), requestCancel: vi.fn(),
        attachNextAttemptAuthorization: vi.fn() },
      output: { issue: vi.fn(async () => malformed as never), recover: vi.fn(),
        read: async function* () { yield undefined as never; } },
      caller: { resolve: () => ({ identity: "spiffe://kokoro/platform-media-worker" }) },
      mediaCallerIdentity: "spiffe://kokoro/platform-media-worker",
    });

    await expect(service.issueImageEffectOutputAccess({ callerAccessHandle: "h".repeat(32),
      outputAccessCommandRef: "output-command:one", logicalInvocationRef: "invocation:one",
      outputEvidenceRef: "output:one", outputEvidenceDigest: "c".repeat(64),
      callerRequestFingerprint: "e".repeat(64) } as never, {} as never))
      .rejects.toMatchObject({ code: Code.Unavailable });
  });
});

function effectCommand(): CreateImageEffectCommand {
  return Object.freeze({ callerAccessHandle: "h".repeat(32), modelInvocationCommandRef: "command:one",
    callerRequestFingerprint: "a".repeat(64), definitionRoleRef: "image.text_to_image.v1",
    modelOptionAuthorizationHandle: "m".repeat(32), modelOptionRevisionRef: "option:one",
    operationInputRevisionRef: "input:one", operationInputRevisionDigest: "b".repeat(64),
    sourceGrants: [{ sourceVersionRef: "source:one", purposeGrantHandle: "s".repeat(32) }],
    logicalOutputSlots: [{ candidateRef: "candidate:one", stableOutputSlotRef: "slot:one" }],
    effectBudgetCommitRef: "budget:one", effectBudgetCommitDigest: "c".repeat(64), attemptOrdinal: 1,
    trustEffectAllowReceiptRef: "trust:one", trustEffectAllowReceiptDigest: "d".repeat(64) });
}

function effectAuthorization(): ImageEffectAccessAuthorization {
  return Object.freeze({ callerAccessHandleDigest: "e".repeat(64), callerIdentity: "media-worker:one",
    siteId: "site:one", callerAudience: "platform-media-worker", workloadIdentityRef: "spiffe://kokoro/media",
    environment: "production", region: "us-east-1", authorizationGeneration: 1n, securityEpoch: 1n,
    accessExpiresAt: "2030-01-01T00:00:00.000Z", sourceGrantClaims: [{ sourceVersionRef: "source:one",
      purposeGrantHandleDigest: "f".repeat(64), expiresAt: "2030-01-01T00:00:00.000Z" }] });
}
