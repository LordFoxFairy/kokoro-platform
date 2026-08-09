import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ModelGatewayService,
  type ModelGatewayInvocationRecord,
  type ModelGatewayRepository,
  type ModelGatewayRequest,
  type ModelGatewayStreamFrame,
  type ModelGatewayStreamPayload,
  type ModelGatewayStreamingRepository,
  type ModelGatewayUnitOfWork,
} from "../../src/modules/model-gateway/application/model-gateway-service.js";

describe("ModelGatewayService streaming owner", () => {
  it("persists accepted first, dispatches once, and resumes from a durable cursor", async () => {
    const repository = new MemoryRepository();
    let providerCalls = 0;
    const responseBody = new TextEncoder().encode(
      '{"choices":[{"index":0,"message":{"content":"hello","role":"assistant"}}],"id":"chatcmpl-1"}',
    );
    const service = new ModelGatewayService({
      unitOfWork: unitOfWork(),
      repository,
      streamingRepository: repository,
      provider: {
        prepare: () => ({
          gatewayModel: "chat-primary",
          requestDigest: "a".repeat(64),
          maximumDimensions: [
            { dimensionKey: "output_tokens", sourceUnit: "token", quantity: 16n },
          ],
          stream: async function* () {
            providerCalls += 1;
            yield { kind: "content_delta", content: "hello" } as const;
            yield { kind: "terminal", outcome: {
              kind: "succeeded",
              responseBody,
              usage: null,
              responseDigest: sha256(responseBody),
              sourceDigest: "b".repeat(64),
              occurredAt: "2029-01-01T00:00:01.000Z",
            } } as const;
          },
        }),
      },
      usageOwner: usageOwner(),
      reference: (kind) => kind === "invocation" ? "invocation-1" : "evidence-1",
      clock: () => new Date("2029-01-01T00:00:00.000Z"),
      instanceRef: "model-gateway:test",
    });

    const first = await collect(service.stream({ ...invocation(), afterSequence: 0n }));
    expect(first.map(({ payload }) => payload.kind)).toEqual([
      "accepted", "content_delta", "completed",
    ]);
    const resumed = await collect(service.stream({ ...invocation(), afterSequence: 1n }));
    expect(resumed.map(({ sequence }) => sequence)).toEqual([2n, 3n]);
    expect(providerCalls).toBe(1);
    await service.shutdown();
  });

  it("marks a repeated unary invocation as an attachment without redispatching the provider", async () => {
    const repository = new MemoryRepository();
    let providerCalls = 0;
    const responseBody = new TextEncoder().encode(
      '{"choices":[{"index":0,"message":{"content":"hello","role":"assistant"}}],"id":"chatcmpl-1"}',
    );
    const service = new ModelGatewayService({
      unitOfWork: unitOfWork(),
      repository,
      streamingRepository: repository,
      provider: {
        prepare: () => ({
          gatewayModel: "chat-primary",
          requestDigest: "a".repeat(64),
          maximumDimensions: [
            { dimensionKey: "output_tokens", sourceUnit: "token", quantity: 16n },
          ],
          stream: async function* () {
            providerCalls += 1;
            yield { kind: "terminal", outcome: {
              kind: "succeeded",
              responseBody,
              usage: null,
              responseDigest: sha256(responseBody),
              sourceDigest: "b".repeat(64),
              occurredAt: "2029-01-01T00:00:01.000Z",
            } } as const;
          },
        }),
      },
      usageOwner: usageOwner(),
      reference: (kind) => kind === "invocation" ? "invocation-1" : "evidence-1",
      clock: () => new Date("2029-01-01T00:00:00.000Z"),
      instanceRef: "model-gateway:test",
    });

    const first = await service.invoke(invocation());
    const attached = await service.invoke(invocation());

    expect(first.replayed).toBe(false);
    expect(attached.replayed).toBe(true);
    expect(attached.invocationRef).toBe(first.invocationRef);
    expect(providerCalls).toBe(1);
    await service.shutdown();
  });

  it("selects the provider adapter only from the resolved authorization", async () => {
    const repository = new MemoryRepository();
    const selected: string[] = [];
    const responseBody = new TextEncoder().encode('{"choices":[]}');
    const service = new ModelGatewayService({
      unitOfWork: unitOfWork("direct"),
      repository,
      streamingRepository: repository,
      provider: {
        prepare: (_request, authorization) => {
          selected.push(`${authorization.adapterKind}:${authorization.providerModel}`);
          return {
            gatewayModel: "chat-primary",
            requestDigest: "a".repeat(64),
            maximumDimensions: [
              { dimensionKey: "output_tokens", sourceUnit: "token", quantity: 16n },
            ],
            stream: async function* () {
              yield { kind: "terminal", outcome: {
                kind: "succeeded",
                responseBody,
                usage: null,
                responseDigest: sha256(responseBody),
                sourceDigest: "b".repeat(64),
                occurredAt: "2029-01-01T00:00:01.000Z",
              } } as const;
            },
          };
        },
      },
      usageOwner: usageOwner(),
      reference: (kind) => kind === "invocation" ? "invocation-1" : "evidence-1",
      clock: () => new Date("2029-01-01T00:00:00.000Z"),
      instanceRef: "model-gateway:test",
    });

    await service.invoke(invocation());

    expect(selected).toEqual(["direct:provider-chat-v1"]);
    await service.shutdown();
  });

  it("uses the complete frozen authorization when recovering a queued invocation", async () => {
    const repository = new MemoryRepository();
    repository.record = queuedRecord();
    repository.request = invocation().request;
    let scans = 0;
    let selected: unknown;
    let preparedResolve: (() => void) | undefined;
    const prepared = new Promise<void>((resolve) => { preparedResolve = resolve; });
    const service = new ModelGatewayService({
      unitOfWork: {
        scanDispatchCandidates: async () => scans++ === 0
          ? [{ modelAuthorizationHandle: authorizationHandle, logicalCallRef: "logical-call-1" }]
          : [],
        execute: async (_scope, work) => work({} as never, authorization("direct", "provider-recovery-v2")),
      },
      repository,
      streamingRepository: repository,
      provider: {
        prepare: (_request, resolvedAuthorization) => {
          selected = resolvedAuthorization;
          preparedResolve?.();
          return {
            gatewayModel: "chat-primary",
            requestDigest: "a".repeat(64),
            maximumDimensions: [
              { dimensionKey: "output_tokens", sourceUnit: "token", quantity: 16n },
            ],
            stream: async function* () {},
          };
        },
      },
      usageOwner: usageOwner(),
      clock: () => new Date("2029-01-01T00:00:00.000Z"),
      instanceRef: "model-gateway:test",
    });

    service.start();
    await Promise.race([
      prepared,
      new Promise<never>((_resolve, reject) => setTimeout(
        () => reject(new Error("recovery prepare timeout")), 2_000,
      )),
    ]);

    expect(selected).toEqual(authorization("direct", "provider-recovery-v2"));
    await service.shutdown();
  });
});

class MemoryRepository implements ModelGatewayRepository, ModelGatewayStreamingRepository {
  record: ModelGatewayInvocationRecord | null = null;
  request: ModelGatewayRequest | null = null;
  frames: ModelGatewayStreamFrame[] = [];

  async lockInvocation(_transaction: never, input: Readonly<{ logicalCallRef: string }>) {
    return this.record?.logicalCallRef === input.logicalCallRef ? this.record : null;
  }
  async reserveCapacity() {}
  async persistAccepted(_transaction: never, record: ModelGatewayInvocationRecord, request: ModelGatewayRequest) {
    this.record = record;
    this.request = request;
    const accepted = this.frame({ kind: "accepted" });
    this.frames.push(accepted);
    return record;
  }
  async loadRequest() {
    if (this.request === null) throw new Error("missing request");
    return this.request;
  }
  async claimInvocation(_transaction: never, input: Readonly<{
    record: ModelGatewayInvocationRecord;
    ownerInstanceRef: string;
    leaseDurationMs: number;
  }>) {
    if (this.record?.state !== "queued") return null;
    const databaseNow = Date.parse(input.record.updatedAt);
    this.record = { ...input.record, state: "dispatching", dispatchOwnerRef: input.ownerInstanceRef,
      dispatchFence: 1n,
      dispatchLeaseExpiresAt: new Date(databaseNow + input.leaseDurationMs).toISOString() };
    return this.record;
  }
  async appendFrame(_transaction: never, input: Readonly<{
    record: ModelGatewayInvocationRecord;
    ownerInstanceRef: string;
    payload: Extract<ModelGatewayStreamPayload,
      { kind: "content_delta" | "reasoning_delta" | "tool_call_delta" }>;
  }>) {
    const frame = this.frame(input.payload);
    this.frames.push(frame);
    return frame;
  }
  async heartbeat(_transaction: never, input: Readonly<{
    record: ModelGatewayInvocationRecord;
    leaseDurationMs: number;
  }>) {
    if (this.record === null) throw new Error("missing invocation");
    this.record = { ...this.record, dispatchLeaseExpiresAt: new Date(
      Date.parse(this.record.updatedAt) + input.leaseDurationMs,
    ).toISOString() };
    return this.record;
  }
  async persistTerminal(_transaction: never, record: ModelGatewayInvocationRecord) { this.record = record; }
  async persistOutcomeUnknown(_transaction: never, record: ModelGatewayInvocationRecord) { this.record = record; }
  async appendTerminalFrame(_transaction: never, _record: ModelGatewayInvocationRecord,
    payload: Extract<ModelGatewayStreamPayload, { kind: "completed" | "failed" | "outcome_unknown" }>) {
    const frame = this.frame(payload);
    this.frames.push(frame);
    return frame;
  }
  async listFrames(_transaction: never, input: Readonly<{ afterSequence: bigint }>) {
    return this.frames.filter(({ sequence }) => sequence > input.afterSequence);
  }
  frame(payload: ModelGatewayStreamPayload): ModelGatewayStreamFrame {
    const previous = this.frames.at(-1)?.frameDigest ?? "0".repeat(64);
    const sequence = BigInt(this.frames.length + 1);
    return Object.freeze({ invocationRef: "invocation-1", attemptRef: "attempt-1", sequence,
      previousFrameDigest: previous, frameDigest: sha256(`${sequence}:${previous}:${payload.kind}`), payload });
  }
}

function unitOfWork(adapterKind: "litellm" | "direct" = "litellm"): ModelGatewayUnitOfWork {
  return {
    scanDispatchCandidates: async () => [],
    execute: async (_scope, work) => work({} as never, authorization(adapterKind)),
  };
}

function authorization(
  adapterKind: "litellm" | "direct" = "litellm",
  providerModel = "provider-chat-v1",
) {
  return Object.freeze({
    modelAuthorizationHandle: authorizationHandle,
    siteId: "site-a",
    executionManifestRef: "manifest-a",
    authorizationSegmentRef: "segment-a",
    authorizedGatewayModel: "chat-primary",
    providerModel,
    adapterKind,
    expiresAt: "2030-01-01T00:00:00.000Z",
  });
}

function usageOwner() {
  return {
    prepareAttempt: async () => ({ kind: "accepted" as const, value: {
      state: "effect_committed" as const, attemptAuthorizationRef: "attempt-authorization-1", fenceEpoch: 1n,
    } }),
    finalizeAttempt: async (_transaction: unknown, input: Readonly<{ evidenceRef: string }>) => ({
      kind: "accepted" as const, value: { evidenceRef: input.evidenceRef, revision: 1n },
    }),
    markAttemptOutcomeUnknown: async () => ({ kind: "accepted" as const, value: {
      state: "outcome_unknown" as const, fenceEpoch: 2n,
      attemptAuthorizationRef: "attempt-authorization-1",
    } }),
  };
}

const authorizationHandle = `model-authorization:sha256:${"f".repeat(64)}`;
function invocation() {
  return {
    modelAuthorizationHandle: authorizationHandle,
    logicalCallRef: "logical-call-1",
    attemptRef: "attempt-1",
    producerContext: "ga-run-1",
    producerGeneration: 1n,
    request: { protocol: "openai.chat.completions.v1" as const, model: "chat-primary",
      messages: [{ role: "user" as const, content: "hello", toolCalls: [] }],
      maxOutputTokens: 16, tools: [], toolChoice: "none" as const },
    signal: AbortSignal.timeout(5_000),
  };
}
function queuedRecord(): ModelGatewayInvocationRecord {
  return Object.freeze({
    siteId: "site-a",
    invocationRef: "invocation-1",
    modelAuthorizationHandle: authorizationHandle,
    executionManifestRef: "manifest-a",
    authorizationSegmentRef: "segment-a",
    logicalCallRef: "logical-call-1",
    attemptRef: "attempt-1",
    producerContext: "ga-run-1",
    producerGeneration: 1n,
    requestDigest: "a".repeat(64),
    gatewayModel: "chat-primary",
    maximumDimensions: Object.freeze([
      Object.freeze({ dimensionKey: "output_tokens", sourceUnit: "token", quantity: 16n }),
    ]),
    attemptAuthorizationRef: "attempt-authorization-1",
    fenceEpoch: 1n,
    state: "queued",
    responseBody: null,
    usageEvidence: null,
    evidenceRef: null,
    sourceDigest: null,
    ownerEvidenceRef: null,
    dispatchOwnerRef: null,
    dispatchFence: 0n,
    dispatchLeaseExpiresAt: null,
    createdAt: "2029-01-01T00:00:00.000Z",
    updatedAt: "2029-01-01T00:00:00.000Z",
  });
}
async function collect(source: AsyncIterable<ModelGatewayStreamFrame>) {
  const result: ModelGatewayStreamFrame[] = [];
  for await (const frame of source) result.push(frame);
  return result;
}
function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
