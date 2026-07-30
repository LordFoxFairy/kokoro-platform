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
            { dimensionKey: "output_tokens", sourceUnit: "tokens", quantity: 16n },
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
    return accepted;
  }
  async loadRequest() {
    if (this.request === null) throw new Error("missing request");
    return this.request;
  }
  async claimInvocation(_transaction: never, input: Readonly<{
    record: ModelGatewayInvocationRecord;
    ownerInstanceRef: string;
    leaseExpiresAt: string;
  }>) {
    if (this.record?.state !== "queued") return null;
    this.record = { ...input.record, state: "dispatching", dispatchOwnerRef: input.ownerInstanceRef,
      dispatchFence: 1n, dispatchLeaseExpiresAt: input.leaseExpiresAt };
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
  async heartbeat() {}
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

function unitOfWork(): ModelGatewayUnitOfWork {
  return {
    scanDispatchCandidates: async () => [],
    execute: async (_scope, work) => work({} as never, {
      modelAuthorizationHandle: authorizationHandle,
      siteId: "site-a",
      executionManifestRef: "manifest-a",
      authorizationSegmentRef: "segment-a",
      authorizedGatewayModel: "chat-primary",
      expiresAt: "2030-01-01T00:00:00.000Z",
    }),
  };
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
async function collect(source: AsyncIterable<ModelGatewayStreamFrame>) {
  const result: ModelGatewayStreamFrame[] = [];
  for await (const frame of source) result.push(frame);
  return result;
}
function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
