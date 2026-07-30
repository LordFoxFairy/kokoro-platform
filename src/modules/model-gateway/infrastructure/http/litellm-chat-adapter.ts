import { createHash } from "node:crypto";
import type {
  ModelGatewayJsonValue,
  ModelGatewayProviderOutcome,
  ModelGatewayProviderPort,
  ModelGatewayProviderStreamEvent,
  ModelGatewayRequest,
  ModelUsageDimension,
  PreparedModelProviderRequest,
} from "../../application/model-gateway-service.js";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_TOKENS = 1_000_000;

type FetchPort = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Narrow certified chat adapter: one authorized Gateway model alias maps to
 * one LiteLLM alias. Routing, retry, fallback, spend and customer rating stay
 * outside LiteLLM.
 */
export class LiteLlmChatAdapter implements ModelGatewayProviderPort {
  readonly #endpoint: string;
  readonly #apiKey: string;
  readonly #fetch: FetchPort;
  readonly #timeoutMs: number;
  readonly #clock: () => Date;

  constructor(input: Readonly<{
    endpoint: string;
    apiKey: string;
    fetch?: FetchPort;
    timeoutMs?: number;
    clock?: () => Date;
  }>) {
    this.#endpoint = endpoint(input.endpoint);
    if (
      input.apiKey.length < 1 || input.apiKey.length > 4_096 ||
      hasControlCharacter(input.apiKey)
    ) throw new Error("MODEL_GATEWAY_LITELLM_KEY_INVALID");
    this.#apiKey = input.apiKey;
    this.#fetch = input.fetch ?? fetch;
    this.#timeoutMs = input.timeoutMs ?? 30_000;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 100 || this.#timeoutMs > 120_000) {
      throw new Error("MODEL_GATEWAY_LITELLM_TIMEOUT_INVALID");
    }
    this.#clock = input.clock ?? (() => new Date());
  }

  prepare(request: ModelGatewayRequest): PreparedModelProviderRequest {
    validateRequest(request);
    const providerBody = Object.freeze({
      model: request.model,
      messages: request.messages.map(providerMessage),
      max_completion_tokens: request.maxOutputTokens,
      ...(request.tools.length === 0
        ? {}
        : {
            tools: request.tools.map((tool) => Object.freeze({
              type: "function",
              function: Object.freeze({
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
              }),
            })),
            tool_choice: providerToolChoice(request.toolChoice),
          }),
      stream: true,
      stream_options: Object.freeze({ include_usage: true }),
    });
    const body = new TextEncoder().encode(JSON.stringify(providerBody));
    if (body.byteLength < 1 || body.byteLength > MAX_REQUEST_BYTES) {
      throw new Error("MODEL_GATEWAY_CHAT_REQUEST_TOO_LARGE");
    }
    const requestDigest = sha256(body);
    const maximumDimensions = Object.freeze([
      // UTF-8 bytes are a conservative upper bound for BPE-family input token counts.
      Object.freeze({
        dimensionKey: "input_tokens",
        sourceUnit: "tokens",
        quantity: BigInt(body.byteLength),
      }),
      Object.freeze({
        dimensionKey: "output_tokens",
        sourceUnit: "tokens",
        quantity: BigInt(request.maxOutputTokens),
      }),
    ] satisfies readonly ModelUsageDimension[]);
    return Object.freeze({
      gatewayModel: request.model,
      requestDigest,
      maximumDimensions,
      stream: (input: Readonly<{ signal: AbortSignal; providerOperationKey: string }>) =>
        this.#stream(body, input),
    });
  }

  async *#stream(
    body: Uint8Array,
    input: Readonly<{ signal: AbortSignal; providerOperationKey: string }>,
  ): AsyncIterable<ModelGatewayProviderStreamEvent> {
    reference(input.providerOperationKey, "MODEL_GATEWAY_PROVIDER_OPERATION_KEY_INVALID");
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(this.#timeoutMs)]);
    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
          accept: "text/event-stream",
          "idempotency-key": input.providerOperationKey,
        },
        body: Buffer.from(body),
        redirect: "error",
        signal,
      });
    } catch (error) {
      yield Object.freeze({
        kind: "terminal" as const,
        outcome: unknownOutcome("litellm-transport", errorNameDigest(error)),
      });
      return;
    }

    if (!response.ok) {
      let responseBody: Uint8Array;
      try {
        responseBody = await readBoundedBody(response, MAX_RESPONSE_BYTES);
      } catch {
        yield Object.freeze({
          kind: "terminal" as const,
          outcome: unknownOutcome("litellm-response", sha256(`${response.status}:body-unavailable`)),
        });
        return;
      }
      const sourceDigest = sha256(responseBody);
      const safeResponseBody = new TextEncoder().encode(JSON.stringify({
        error: {
          code: "MODEL_PROVIDER_REJECTED",
          retryable: response.status === 408 || response.status === 425 || response.status === 429 ||
            response.status >= 500,
        },
      }));
      yield Object.freeze({
        kind: "terminal" as const,
        outcome: Object.freeze({
          kind: "failed" as const,
          responseBody: safeResponseBody,
          usage: null,
          responseDigest: sha256(safeResponseBody),
          sourceDigest,
          occurredAt: this.#now(),
        }),
      });
      return;
    }
    if (!(response.headers.get("content-type") ?? "").toLowerCase().startsWith("text/event-stream")) {
      yield Object.freeze({
        kind: "terminal" as const,
        outcome: unknownOutcome("litellm-response", sha256("content-type-invalid")),
      });
      return;
    }
    const streamState = { hash: createHash("sha256"), totalBytes: 0 };
    const aggregate = createStreamingAggregate();
    try {
      for await (const data of readBoundedSse(response, streamState)) {
        if (data === "[DONE]") {
          if (aggregate.done) throw new Error("MODEL_GATEWAY_LITELLM_SSE_MULTIPLE_TERMINALS");
          aggregate.done = true;
          continue;
        }
        if (aggregate.done) throw new Error("MODEL_GATEWAY_LITELLM_SSE_DATA_AFTER_TERMINAL");
        const parsed = parseStreamChunk(data, aggregate);
        for (const delta of parsed) yield delta;
      }
      const sourceDigest = streamState.hash.digest("hex");
      const completed = completeStreamAggregate(aggregate);
      if (!aggregate.done || completed === null) {
        yield Object.freeze({
          kind: "terminal" as const,
          outcome: unknownOutcome("litellm-stream", sourceDigest),
        });
        return;
      }
      yield Object.freeze({
        kind: "terminal" as const,
        outcome: Object.freeze({
          kind: "succeeded" as const,
          responseBody: completed.safeResponseBody,
          usage: completed.usage,
          responseDigest: sha256(completed.safeResponseBody),
          sourceDigest,
          occurredAt: this.#now(),
        }),
      });
    } catch (error) {
      yield Object.freeze({
        kind: "terminal" as const,
        outcome: unknownOutcome("litellm-stream", sha256(
          `${streamState.totalBytes}:${error instanceof Error ? error.name : typeof error}`,
        )),
      });
    }
  }

  #now(): string {
    const value = this.#clock();
    if (!Number.isFinite(value.getTime())) throw new Error("MODEL_GATEWAY_LITELLM_CLOCK_INVALID");
    return value.toISOString();
  }
}

function validateRequest(request: ModelGatewayRequest): void {
  if (
    request === null || typeof request !== "object" ||
    request.protocol !== "openai.chat.completions.v1" ||
    !safeName(request.model) ||
    !Number.isInteger(request.maxOutputTokens) || request.maxOutputTokens < 1 ||
    request.maxOutputTokens > MAX_OUTPUT_TOKENS ||
    !Array.isArray(request.messages) || request.messages.length < 1 || request.messages.length > 512 ||
    !Array.isArray(request.tools) || request.tools.length > 128
  ) throw new Error("MODEL_GATEWAY_CHAT_REQUEST_INVALID");
  let contentBytes = 0;
  for (const message of request.messages) {
    if (
      message === null || typeof message !== "object" ||
      !["system", "user", "assistant", "tool"].includes(message.role) ||
      typeof message.content !== "string" || !Array.isArray(message.toolCalls) ||
      hasControlCharacter(message.role)
    ) throw new Error("MODEL_GATEWAY_CHAT_REQUEST_INVALID");
    contentBytes += Buffer.byteLength(message.content, "utf8");
    if (contentBytes > MAX_REQUEST_BYTES) throw new Error("MODEL_GATEWAY_CHAT_REQUEST_TOO_LARGE");
    validateMessageShape(message);
    for (const call of message.toolCalls) validateToolCall(call);
  }
  const names = new Set<string>();
  for (const tool of request.tools) {
    if (!safeToolName(tool.name) || names.has(tool.name) ||
        typeof tool.description !== "string" || Buffer.byteLength(tool.description, "utf8") > 65_536 ||
        !jsonRecord(tool.inputSchema)) {
      throw new Error("MODEL_GATEWAY_CHAT_REQUEST_INVALID");
    }
    canonicalJson(tool.inputSchema);
    names.add(tool.name);
  }
  if (request.tools.length === 0 && request.toolChoice !== "none") {
    throw new Error("MODEL_GATEWAY_CHAT_REQUEST_INVALID");
  }
  if (typeof request.toolChoice === "object" &&
      (!safeToolName(request.toolChoice.name) || !names.has(request.toolChoice.name))) {
    throw new Error("MODEL_GATEWAY_CHAT_REQUEST_INVALID");
  }
}

type StreamingToolCall = {
  id?: string;
  name?: string;
  arguments: string;
};

type StreamingAggregate = {
  id?: string;
  content: string;
  reasoning: string;
  finishReason?: string;
  tools: Map<number, StreamingToolCall>;
  usage: readonly ModelUsageDimension[] | null;
  safeUsage?: Readonly<{ prompt_tokens: number; completion_tokens: number }>;
  done: boolean;
  totalOutputBytes: number;
};

function createStreamingAggregate(): StreamingAggregate {
  return {
    content: "",
    reasoning: "",
    tools: new Map(),
    usage: null,
    done: false,
    totalOutputBytes: 0,
  };
}

function parseStreamChunk(
  data: string,
  aggregate: StreamingAggregate,
): readonly ModelGatewayProviderStreamEvent[] {
  let value: unknown;
  try { value = JSON.parse(data); } catch { throw new Error("MODEL_GATEWAY_LITELLM_SSE_JSON_INVALID"); }
  if (!record(value)) throw new Error("MODEL_GATEWAY_LITELLM_SSE_CHUNK_INVALID");
  if (value.id !== undefined) {
    if (!safeReference(value.id) || (aggregate.id !== undefined && aggregate.id !== value.id)) {
      throw new Error("MODEL_GATEWAY_LITELLM_SSE_CHUNK_INVALID");
    }
    aggregate.id = value.id;
  }
  if (value.usage !== undefined && value.usage !== null) {
    if (!record(value.usage)) throw new Error("MODEL_GATEWAY_LITELLM_SSE_USAGE_INVALID");
    const input = safeInteger(value.usage.prompt_tokens);
    const output = safeInteger(value.usage.completion_tokens);
    if (input === null || output === null || input > BigInt(Number.MAX_SAFE_INTEGER) ||
        output > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("MODEL_GATEWAY_LITELLM_SSE_USAGE_INVALID");
    }
    aggregate.usage = Object.freeze([
      Object.freeze({ dimensionKey: "input_tokens", sourceUnit: "tokens", quantity: input }),
      Object.freeze({ dimensionKey: "output_tokens", sourceUnit: "tokens", quantity: output }),
    ]);
    aggregate.safeUsage = Object.freeze({
      prompt_tokens: Number(input), completion_tokens: Number(output),
    });
  }
  if (!Array.isArray(value.choices) || value.choices.length > 1) {
    throw new Error("MODEL_GATEWAY_LITELLM_SSE_CHOICES_INVALID");
  }
  if (value.choices.length === 0) return Object.freeze([]);
  const choice = value.choices[0];
  if (!record(choice) || choice.index !== 0 || !record(choice.delta)) {
    throw new Error("MODEL_GATEWAY_LITELLM_SSE_CHOICE_INVALID");
  }
  const result: ModelGatewayProviderStreamEvent[] = [];
  const content = choice.delta.content;
  if (content !== undefined && content !== null) {
    if (typeof content !== "string") throw new Error("MODEL_GATEWAY_LITELLM_SSE_CONTENT_INVALID");
    aggregate.content += content;
    aggregate.totalOutputBytes += Buffer.byteLength(content, "utf8");
    if (aggregate.totalOutputBytes > MAX_RESPONSE_BYTES) {
      throw new Error("MODEL_GATEWAY_LITELLM_SSE_RESPONSE_TOO_LARGE");
    }
    for (const part of splitUtf8(content, 16_384)) {
      if (part.length > 0) result.push(Object.freeze({ kind: "content_delta", content: part }));
    }
  }
  const reasoning = choice.delta.reasoning_content;
  if (reasoning !== undefined && reasoning !== null) {
    if (typeof reasoning !== "string") throw new Error("MODEL_GATEWAY_LITELLM_SSE_REASONING_INVALID");
    aggregate.reasoning += reasoning;
    aggregate.totalOutputBytes += Buffer.byteLength(reasoning, "utf8");
    if (aggregate.totalOutputBytes > MAX_RESPONSE_BYTES) {
      throw new Error("MODEL_GATEWAY_LITELLM_SSE_RESPONSE_TOO_LARGE");
    }
    for (const part of splitUtf8(reasoning, 16_384)) {
      if (part.length > 0) result.push(Object.freeze({ kind: "reasoning_delta", content: part }));
    }
  }
  const toolCalls = choice.delta.tool_calls;
  if (toolCalls !== undefined) {
    if (!Array.isArray(toolCalls) || toolCalls.length > 128) {
      throw new Error("MODEL_GATEWAY_LITELLM_SSE_TOOL_INVALID");
    }
    for (const raw of toolCalls) {
      if (!record(raw) || !Number.isInteger(raw.index) || (raw.index as number) < 0 ||
          (raw.index as number) > 127) throw new Error("MODEL_GATEWAY_LITELLM_SSE_TOOL_INVALID");
      const index = raw.index as number;
      const current = aggregate.tools.get(index) ?? { arguments: "" };
      if (raw.id !== undefined) {
        const rawId = raw.id;
        if (!safeReference(rawId) || (current.id !== undefined && current.id !== rawId)) {
          throw new Error("MODEL_GATEWAY_LITELLM_SSE_TOOL_INVALID");
        }
        current.id = rawId;
      }
      let name: string | undefined;
      let argumentsFragment = "";
      if (raw.function !== undefined) {
        if (!record(raw.function)) throw new Error("MODEL_GATEWAY_LITELLM_SSE_TOOL_INVALID");
        if (raw.function.name !== undefined) {
          if (!safeToolName(raw.function.name) ||
              (current.name !== undefined && current.name !== raw.function.name)) {
            throw new Error("MODEL_GATEWAY_LITELLM_SSE_TOOL_INVALID");
          }
          current.name = raw.function.name;
          name = raw.function.name;
        }
        if (raw.function.arguments !== undefined) {
          if (typeof raw.function.arguments !== "string") {
            throw new Error("MODEL_GATEWAY_LITELLM_SSE_TOOL_INVALID");
          }
          argumentsFragment = raw.function.arguments;
          current.arguments += argumentsFragment;
          aggregate.totalOutputBytes += Buffer.byteLength(argumentsFragment, "utf8");
          if (aggregate.totalOutputBytes > MAX_RESPONSE_BYTES) {
            throw new Error("MODEL_GATEWAY_LITELLM_SSE_RESPONSE_TOO_LARGE");
          }
          if (Buffer.byteLength(current.arguments, "utf8") > 1024 * 1024) {
            throw new Error("MODEL_GATEWAY_LITELLM_SSE_TOOL_TOO_LARGE");
          }
        }
      }
      aggregate.tools.set(index, current);
      const parts = splitUtf8(argumentsFragment, 16_384);
      if (parts.length === 0) parts.push("");
      parts.forEach((part, partIndex) => result.push(Object.freeze({
        kind: "tool_call_delta" as const,
        toolIndex: index,
        ...(partIndex === 0 && current.id !== undefined ? { id: current.id } : {}),
        ...(partIndex === 0 && name !== undefined ? { name } : {}),
        argumentsJsonFragment: new TextEncoder().encode(part),
      })));
    }
  }
  if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
    if (typeof choice.finish_reason !== "string" || choice.finish_reason.length < 1 ||
        choice.finish_reason.length > 64) throw new Error("MODEL_GATEWAY_LITELLM_SSE_FINISH_INVALID");
    aggregate.finishReason = choice.finish_reason;
  }
  return Object.freeze(result);
}

function completeStreamAggregate(aggregate: StreamingAggregate): Readonly<{
  usage: readonly ModelUsageDimension[] | null;
  safeResponseBody: Uint8Array;
}> | null {
  if (aggregate.id === undefined || (aggregate.content.length === 0 && aggregate.tools.size === 0)) return null;
  const toolCalls: ModelGatewayJsonValue[] = [];
  for (const [index, tool] of [...aggregate.tools].sort(([left], [right]) => left - right)) {
    if (index !== toolCalls.length || tool.id === undefined || tool.name === undefined) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(tool.arguments); } catch { return null; }
    if (!jsonRecord(parsed)) return null;
    toolCalls.push(Object.freeze({
      id: tool.id,
      type: "function",
      function: Object.freeze({ name: tool.name, arguments: canonicalJson(parsed) }),
    }));
  }
  const safe = Object.freeze({
    id: aggregate.id,
    choices: Object.freeze([Object.freeze({
      index: 0,
      message: Object.freeze({
        role: "assistant",
        content: aggregate.content,
        ...(aggregate.reasoning.length === 0 ? {} : { reasoning_content: aggregate.reasoning }),
        ...(toolCalls.length === 0 ? {} : { tool_calls: Object.freeze(toolCalls) }),
      }),
      ...(aggregate.finishReason === undefined ? {} : { finish_reason: aggregate.finishReason }),
    })]),
    ...(aggregate.safeUsage === undefined ? {} : { usage: aggregate.safeUsage }),
  });
  if (!jsonValue(safe)) return null;
  return Object.freeze({
    usage: aggregate.usage,
    safeResponseBody: new TextEncoder().encode(canonicalJson(safe)),
  });
}

async function* readBoundedSse(
  response: Response,
  state: { hash: ReturnType<typeof createHash>; totalBytes: number },
): AsyncIterable<string> {
  if (response.body === null) throw new Error("MODEL_GATEWAY_LITELLM_SSE_EMPTY");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffered = "";
  let dataLines: string[] = [];
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      state.totalBytes += item.value.byteLength;
      if (state.totalBytes > 16 * 1024 * 1024) throw new Error("MODEL_GATEWAY_LITELLM_SSE_TOO_LARGE");
      state.hash.update(item.value);
      buffered += decoder.decode(item.value, { stream: true });
      if (Buffer.byteLength(buffered, "utf8") > 1024 * 1024) {
        throw new Error("MODEL_GATEWAY_LITELLM_SSE_EVENT_TOO_LARGE");
      }
      while (true) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        let line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line.length === 0) {
          if (dataLines.length > 0) {
            const data = dataLines.join("\n");
            dataLines = [];
            yield data;
          }
        } else if (line.startsWith("data:")) {
          const data = line.slice(5);
          dataLines.push(data.startsWith(" ") ? data.slice(1) : data);
        } else if (!line.startsWith(":")) {
          const field = line.split(":", 1)[0];
          if (field !== "event" && field !== "id" && field !== "retry") {
            throw new Error("MODEL_GATEWAY_LITELLM_SSE_FIELD_INVALID");
          }
        }
      }
    }
    buffered += decoder.decode();
    if (buffered.length > 0) {
      const line = buffered.endsWith("\r") ? buffered.slice(0, -1) : buffered;
      if (line.startsWith("data:")) {
        const data = line.slice(5);
        dataLines.push(data.startsWith(" ") ? data.slice(1) : data);
      } else if (line.length > 0) throw new Error("MODEL_GATEWAY_LITELLM_SSE_TRUNCATED");
    }
    if (dataLines.length > 0) yield dataLines.join("\n");
  } finally {
    reader.releaseLock();
  }
}

function splitUtf8(value: string, maximumBytes: number): string[] {
  if (value.length === 0) return [];
  const result: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (currentBytes + bytes > maximumBytes) {
      result.push(current);
      current = "";
      currentBytes = 0;
    }
    current += character;
    currentBytes += bytes;
  }
  if (current.length > 0) result.push(current);
  return result;
}

function providerMessage(message: ModelGatewayRequest["messages"][number]): Readonly<Record<string, unknown>> {
  return Object.freeze({
    role: message.role,
    content: message.content,
    ...(message.toolCalls.length === 0
      ? {}
      : { tool_calls: message.toolCalls.map((call) => Object.freeze({
          id: call.id,
          type: "function",
          function: Object.freeze({ name: call.name, arguments: canonicalJson(call.arguments) }),
        })) }),
    ...(message.toolCallId === undefined ? {} : { tool_call_id: message.toolCallId }),
    ...(message.name === undefined ? {} : { name: message.name }),
  });
}

function providerToolChoice(value: ModelGatewayRequest["toolChoice"]): unknown {
  return typeof value === "string" ? value : Object.freeze({
    type: "function",
    function: Object.freeze({ name: value.name }),
  });
}

function validateMessageShape(message: ModelGatewayRequest["messages"][number]): void {
  const hasToolCallId = message.toolCallId !== undefined;
  if ((message.role === "tool") !== hasToolCallId ||
      (hasToolCallId && !safeReference(message.toolCallId)) ||
      (message.role !== "assistant" && message.toolCalls.length > 0) ||
      (message.role === "assistant" && message.content.length === 0 && message.toolCalls.length === 0) ||
      (message.role !== "assistant" && message.role !== "tool" && message.content.length === 0) ||
      (message.name !== undefined && !safeToolName(message.name))) {
    throw new Error("MODEL_GATEWAY_CHAT_REQUEST_INVALID");
  }
}

function validateToolCall(call: ModelGatewayRequest["messages"][number]["toolCalls"][number]): void {
  if (!safeReference(call.id) || !safeToolName(call.name) || !jsonRecord(call.arguments)) {
    throw new Error("MODEL_GATEWAY_CHAT_REQUEST_INVALID");
  }
  canonicalJson(call.arguments);
}

function canonicalJson(value: ModelGatewayJsonValue): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("MODEL_GATEWAY_CHAT_REQUEST_INVALID");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
}

function jsonRecord(value: unknown): value is Readonly<{ [key: string]: ModelGatewayJsonValue }> {
  if (!record(value)) return false;
  return Object.values(value).every(jsonValue);
}

function jsonValue(value: unknown): value is ModelGatewayJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(jsonValue);
  return jsonRecord(value);
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<Uint8Array> {
  if (response.body === null) throw new Error("MODEL_GATEWAY_PROVIDER_RESPONSE_EMPTY");
  const length = response.headers.get("content-length");
  if (length !== null && (!/^[0-9]+$/u.test(length) || BigInt(length) > BigInt(maximumBytes))) {
    await response.body.cancel().catch(() => undefined);
    throw new Error("MODEL_GATEWAY_PROVIDER_RESPONSE_TOO_LARGE");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("MODEL_GATEWAY_PROVIDER_RESPONSE_TOO_LARGE");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total < 1) throw new Error("MODEL_GATEWAY_PROVIDER_RESPONSE_EMPTY");
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function endpoint(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("MODEL_GATEWAY_LITELLM_ENDPOINT_INVALID");
  }
  if (
    parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" ||
    parsed.search !== "" || parsed.hash !== "" || parsed.hostname.length < 1 ||
    !/^\/v1\/?$/u.test(parsed.pathname)
  ) throw new Error("MODEL_GATEWAY_LITELLM_ENDPOINT_INVALID");
  parsed.pathname = "/v1/chat/completions";
  return parsed.toString();
}

function unknownOutcome(prefix: string, digest: string): ModelGatewayProviderOutcome {
  return Object.freeze({
    kind: "outcome_unknown",
    ownerEvidenceRef: `${prefix}:sha256:${digest}`,
  });
}

function safeInteger(value: unknown): bigint | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/u.test(value);
}

function safeToolName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}

function safeReference(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(value);
}

function reference(value: string, code: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(value)) throw new Error(code);
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point < 32 || point === 127;
  });
}

function errorNameDigest(error: unknown): string {
  return sha256(error instanceof Error ? error.name : typeof error);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
