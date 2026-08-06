import { create } from "@bufbuild/protobuf";
import { ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import {
  ChatCompletionRequestSchema,
  InvokeModelRequestSchema,
  ModelMessageRole,
  ModelMessageSchema,
  ModelToolChoice,
} from
  "../../src/generated/proto/kokoro/platform/model/v1/model_gateway_pb.js";
import { createModelGatewayConnectService } from
  "../../src/modules/model-gateway/interfaces/connect/model-gateway-connect-service.js";

describe("Model Gateway Connect service", () => {
  it("reports the internal stable error while keeping the client response sanitized", async () => {
    const observed: unknown[] = [];
    const service = createModelGatewayConnectService({
      application: {
        invoke: async () => { throw new Error("MODEL_GATEWAY_PREPARE_DATABASE_FAILED"); },
        stream: async function* () {
          yield* [];
          throw new Error("MODEL_GATEWAY_STREAM_DATABASE_FAILED");
        },
      },
      caller: { resolve: () => ({ identity: "spiffe://kokoro.internal/agent" }) },
      agentCallerIdentity: "spiffe://kokoro.internal/agent",
      onError: (error) => observed.push(error),
    });

    const failure = await Promise.resolve(service.invokeModel(
      create(InvokeModelRequestSchema, {
        modelAuthorizationHandle: `model-authorization:sha256:${"a".repeat(64)}`,
        logicalCallRef: `model-call:sha256:${"b".repeat(64)}`,
        attemptRef: `model-attempt:sha256:${"c".repeat(64)}`,
        producerContext: "ga-run:test",
        producerGeneration: 1n,
        request: create(ChatCompletionRequestSchema, {
          protocol: "openai.chat.completions.v1",
          model: "chat-primary",
          messages: [create(ModelMessageSchema, {
            role: ModelMessageRole.USER,
            content: "test",
          })],
          maxOutputTokens: 16,
          toolChoice: ModelToolChoice.NONE,
        }),
      }),
      { signal: AbortSignal.timeout(1_000) } as never,
    )).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ConnectError);
    expect((failure as ConnectError).message).toBe("[unavailable] model gateway unavailable");
    expect(observed).toHaveLength(1);
    expect((observed[0] as Error).message).toBe("MODEL_GATEWAY_PREPARE_DATABASE_FAILED");
  });
});
