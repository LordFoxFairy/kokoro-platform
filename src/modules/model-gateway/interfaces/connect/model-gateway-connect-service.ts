import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import { z } from "zod";
import {
  InvokeModelResponseSchema,
  ModelAcceptedSchema,
  ModelCompletedSchema,
  ModelContentDeltaSchema,
  ModelFailedSchema,
  ModelGatewayService as ModelGatewayConnectDefinition,
  ModelMessageRole,
  ModelOutcomeUnknownSchema,
  ModelReasoningDeltaSchema,
  ModelToolCallDeltaSchema,
  ModelToolCallSchema,
  ModelToolChoice,
  ModelUsageSchema,
  StreamModelResponseSchema,
  type InvokeModelRequest,
} from "../../../../interfaces/connect/generated-model-gateway/kokoro/platform/model/v1/model_gateway_pb.js";
import {
  ModelGatewayService,
  type ModelGatewayJsonValue,
  type ModelGatewayRequest,
  type ModelGatewayStreamPayload,
} from "../../application/model-gateway-service.js";

export type ModelGatewayConnectService = ServiceImpl<typeof ModelGatewayConnectDefinition>;

export interface VerifiedModelGatewayCallerResolver {
  resolve(context: HandlerContext): Readonly<{ identity: string }>;
}

export function createModelGatewayConnectService(input: Readonly<{
  application: Pick<ModelGatewayService, "invoke" | "stream">;
  caller: VerifiedModelGatewayCallerResolver;
  agentCallerIdentity: string;
}>): ModelGatewayConnectService {
  if (typeof input.caller?.resolve !== "function" || !input.agentCallerIdentity.startsWith("spiffe://")) {
    throw new Error("MODEL_GATEWAY_VERIFIED_CALLER_REQUIRED");
  }
  return {
    invokeModel: (request, context) => safeInvoke(async () => {
      if (input.caller.resolve(context).identity !== input.agentCallerIdentity) {
        throw new ConnectError("model gateway caller not authorized", Code.PermissionDenied);
      }
      const result = await input.application.invoke({
        modelAuthorizationHandle: request.modelAuthorizationHandle,
        logicalCallRef: request.logicalCallRef,
        attemptRef: request.attemptRef,
        producerContext: request.producerContext,
        producerGeneration: request.producerGeneration,
        request: mapRequest(request),
        signal: context.signal,
      });
      const common = {
        invocationRef: result.invocationRef,
        attemptRef: result.attemptRef,
        replayed: result.replayed,
      };
      if (result.kind === "outcome_unknown") {
        return create(InvokeModelResponseSchema, {
          ...common,
          outcome: { case: "outcomeUnknown", value: create(ModelOutcomeUnknownSchema) },
        });
      }
      const safe = safeResponseSchema.parse(JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(result.responseBody),
      ));
      if (result.kind === "failed") {
        if (!("error" in safe)) throw new Error("MODEL_GATEWAY_SAFE_RESPONSE_KIND_INVALID");
        return create(InvokeModelResponseSchema, {
          ...common,
          outcome: {
            case: "failed",
            value: create(ModelFailedSchema, safe.error),
          },
        });
      }
      if ("error" in safe) throw new Error("MODEL_GATEWAY_SAFE_RESPONSE_KIND_INVALID");
      const choice = safe.choices[0];
      if (choice === undefined) throw new Error("MODEL_GATEWAY_SAFE_RESPONSE_INVALID");
      return create(InvokeModelResponseSchema, {
        ...common,
        outcome: {
          case: "completed",
          value: create(ModelCompletedSchema, {
            responseId: safe.id,
            content: choice.message.content,
            toolCalls: choice.message.tool_calls?.map((call) => create(ModelToolCallSchema, {
              id: call.id,
              name: call.function.name,
              argumentsJson: new TextEncoder().encode(call.function.arguments),
            })) ?? [],
            ...(choice.message.reasoning_content === undefined
              ? {}
              : { reasoningContent: choice.message.reasoning_content }),
            ...(choice.finish_reason === undefined ? {} : { finishReason: choice.finish_reason }),
            ...(safe.usage === undefined
              ? {}
              : { usage: create(ModelUsageSchema, {
                  inputTokens: BigInt(safe.usage.prompt_tokens),
                  outputTokens: BigInt(safe.usage.completion_tokens),
                }) }),
          }),
        },
      });
    }),
    streamModel: async function* (request, context) {
      try {
        if (input.caller.resolve(context).identity !== input.agentCallerIdentity) {
          throw new ConnectError("model gateway caller not authorized", Code.PermissionDenied);
        }
        if (request.invocation === undefined) {
          throw new ConnectError("model request invalid", Code.InvalidArgument);
        }
        for await (const frame of input.application.stream({
          modelAuthorizationHandle: request.invocation.modelAuthorizationHandle,
          logicalCallRef: request.invocation.logicalCallRef,
          attemptRef: request.invocation.attemptRef,
          producerContext: request.invocation.producerContext,
          producerGeneration: request.invocation.producerGeneration,
          request: mapRequest(request.invocation),
          afterSequence: request.afterSequence,
          signal: context.signal,
        })) {
          yield create(StreamModelResponseSchema, {
            invocationRef: frame.invocationRef,
            attemptRef: frame.attemptRef,
            sequence: frame.sequence,
            previousFrameDigest: frame.previousFrameDigest,
            frameDigest: frame.frameDigest,
            payload: streamPayload(frame.payload),
          });
        }
      } catch (error) {
        throw connectError(error);
      }
    },
  };
}

function streamPayload(payload: ModelGatewayStreamPayload) {
  if (payload.kind === "accepted") {
    return { case: "accepted" as const, value: create(ModelAcceptedSchema) };
  }
  if (payload.kind === "content_delta") {
    return { case: "contentDelta" as const, value: create(ModelContentDeltaSchema, { content: payload.content }) };
  }
  if (payload.kind === "reasoning_delta") {
    return { case: "reasoningDelta" as const,
      value: create(ModelReasoningDeltaSchema, { content: payload.content }) };
  }
  if (payload.kind === "tool_call_delta") {
    return { case: "toolCallDelta" as const, value: create(ModelToolCallDeltaSchema, {
      toolIndex: payload.toolIndex,
      ...(payload.id === undefined ? {} : { id: payload.id }),
      ...(payload.name === undefined ? {} : { name: payload.name }),
      argumentsJsonFragment: payload.argumentsJsonFragment,
    }) };
  }
  if (payload.kind === "outcome_unknown") {
    return { case: "outcomeUnknown" as const, value: create(ModelOutcomeUnknownSchema) };
  }
  const safe = safeResponseSchema.parse(JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(payload.responseBody),
  ));
  if (payload.kind === "failed") {
    if (!("error" in safe)) throw new Error("MODEL_GATEWAY_SAFE_RESPONSE_KIND_INVALID");
    return { case: "failed" as const, value: create(ModelFailedSchema, safe.error) };
  }
  if ("error" in safe) throw new Error("MODEL_GATEWAY_SAFE_RESPONSE_KIND_INVALID");
  const choice = safe.choices[0];
  return { case: "completed" as const, value: create(ModelCompletedSchema, {
    responseId: safe.id,
    content: choice.message.content,
    toolCalls: choice.message.tool_calls?.map((call) => create(ModelToolCallSchema, {
      id: call.id, name: call.function.name,
      argumentsJson: new TextEncoder().encode(call.function.arguments),
    })) ?? [],
    ...(choice.message.reasoning_content === undefined ? {} : {
      reasoningContent: choice.message.reasoning_content,
    }),
    ...(choice.finish_reason === undefined ? {} : { finishReason: choice.finish_reason }),
    ...(safe.usage === undefined ? {} : { usage: create(ModelUsageSchema, {
      inputTokens: BigInt(safe.usage.prompt_tokens), outputTokens: BigInt(safe.usage.completion_tokens),
    }) }),
  }) };
}

function mapRequest(input: InvokeModelRequest): ModelGatewayRequest {
  if (input.request === undefined || input.request.protocol !== "openai.chat.completions.v1") {
    throw new ConnectError("model request invalid", Code.InvalidArgument);
  }
  const tools = input.request.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: parseCanonicalJsonObject(tool.inputSchemaJson),
  }));
  const toolChoice: ModelGatewayRequest["toolChoice"] =
    input.request.requiredToolName !== undefined
      ? { name: input.request.requiredToolName }
      : input.request.toolChoice === ModelToolChoice.AUTO
        ? "auto"
        : input.request.toolChoice === ModelToolChoice.NONE
          ? "none"
          : input.request.toolChoice === ModelToolChoice.REQUIRED
            ? "required"
            : invalidToolChoice();
  return Object.freeze({
    protocol: "openai.chat.completions.v1",
    model: input.request.model,
    messages: Object.freeze(input.request.messages.map((message) => Object.freeze({
      role: role(message.role),
      content: message.content,
      toolCalls: Object.freeze(message.toolCalls.map((call) => Object.freeze({
        id: call.id,
        name: call.name,
        arguments: parseCanonicalJsonObject(call.argumentsJson),
      }))),
      ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
      ...(message.name === undefined ? {} : { name: message.name }),
    }))),
    maxOutputTokens: input.request.maxOutputTokens,
    tools: Object.freeze(tools),
    toolChoice,
  });
}

function role(value: ModelMessageRole): ModelGatewayRequest["messages"][number]["role"] {
  if (value === ModelMessageRole.SYSTEM) return "system";
  if (value === ModelMessageRole.USER) return "user";
  if (value === ModelMessageRole.ASSISTANT) return "assistant";
  if (value === ModelMessageRole.TOOL) return "tool";
  throw new ConnectError("model request invalid", Code.InvalidArgument);
}

function invalidToolChoice(): never {
  throw new ConnectError("model request invalid", Code.InvalidArgument);
}

function parseCanonicalJsonObject(bytes: Uint8Array): Readonly<{ [key: string]: ModelGatewayJsonValue }> {
  let parsed: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(text);
    if (!jsonRecord(parsed) || canonicalJson(parsed) !== text) throw new Error("not canonical");
  } catch {
    throw new ConnectError("model request invalid", Code.InvalidArgument);
  }
  return parsed;
}

function canonicalJson(value: ModelGatewayJsonValue): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("invalid number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
}

function jsonRecord(value: unknown): value is Readonly<{ [key: string]: ModelGatewayJsonValue }> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.values(value).every(jsonValue);
}

function jsonValue(value: unknown): value is ModelGatewayJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(jsonValue);
  return jsonRecord(value);
}

const safeToolCallSchema = z.object({
  id: z.string().min(1).max(256),
  type: z.literal("function"),
  function: z.object({
    name: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u),
    arguments: z.string().min(2).max(1024 * 1024),
  }).strict(),
}).strict();

const safeResponseSchema = z.union([
  z.object({
    id: z.string().min(1).max(256),
    choices: z.tuple([z.object({
      index: z.literal(0),
      message: z.object({
        role: z.literal("assistant"),
        content: z.string().max(8 * 1024 * 1024),
        reasoning_content: z.string().max(8 * 1024 * 1024).optional(),
        tool_calls: z.array(safeToolCallSchema).max(128).optional(),
      }).strict(),
      finish_reason: z.string().min(1).max(64).optional(),
    }).strict()]),
    usage: z.object({
      prompt_tokens: z.number().int().nonnegative(),
      completion_tokens: z.number().int().nonnegative(),
    }).strict().optional(),
  }).strict(),
  z.object({
    error: z.object({ code: z.string().min(1).max(128), retryable: z.boolean() }).strict(),
  }).strict(),
]);

async function safeInvoke<Result>(work: () => Promise<Result>): Promise<Result> {
  try {
    return await work();
  } catch (error) {
    throw connectError(error);
  }
}

function connectError(error: unknown): ConnectError {
  if (error instanceof ConnectError) return error;
  const code = error instanceof Error ? error.message : "";
  if (code.includes("RESOURCE_EXHAUSTED")) {
    return new ConnectError("model gateway at capacity", Code.ResourceExhausted);
  }
  if (code.includes("INVALID") || code.includes("TOO_LARGE")) {
    return new ConnectError("model request invalid", Code.InvalidArgument);
  }
  if (code.includes("CONFLICT") || code.includes("NOT_OPEN") || code.includes("FENCE")) {
    return new ConnectError("model invocation not executable", Code.FailedPrecondition);
  }
  if (code.includes("AUTHORIZATION") || code.includes("ROUTE_NOT_AUTHORIZED")) {
    return new ConnectError("model invocation not authorized", Code.PermissionDenied);
  }
  return new ConnectError("model gateway unavailable", Code.Unavailable);
}
