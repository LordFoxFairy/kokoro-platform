import { createHash } from "node:crypto";
import type {
  ModelGatewayJsonValue,
  ModelGatewayProviderOutcome,
  ModelGatewayProviderPort,
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
 * Narrow certified Phase-A adapter: one authorized Gateway model alias maps to
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
      stream: false,
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
      invoke: (input: Readonly<{ signal: AbortSignal; providerOperationKey: string }>) =>
        this.#invoke(body, input),
    });
  }

  async #invoke(
    body: Uint8Array,
    input: Readonly<{ signal: AbortSignal; providerOperationKey: string }>,
  ): Promise<ModelGatewayProviderOutcome> {
    reference(input.providerOperationKey, "MODEL_GATEWAY_PROVIDER_OPERATION_KEY_INVALID");
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(this.#timeoutMs)]);
    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
          "idempotency-key": input.providerOperationKey,
        },
        body: Buffer.from(body),
        redirect: "error",
        signal,
      });
    } catch (error) {
      return unknownOutcome("litellm-transport", errorNameDigest(error));
    }

    let responseBody: Uint8Array;
    try {
      responseBody = await readBoundedBody(response, MAX_RESPONSE_BYTES);
    } catch {
      return unknownOutcome("litellm-response", sha256(`${response.status}:body-unavailable`));
    }
    const sourceDigest = sha256(responseBody);
    const occurredAt = this.#now();
    if (!response.ok) {
      const safeResponseBody = new TextEncoder().encode(JSON.stringify({
        error: {
          code: "MODEL_PROVIDER_REJECTED",
          retryable: response.status === 408 || response.status === 425 || response.status === 429 ||
            response.status >= 500,
        },
      }));
      return Object.freeze({
        kind: "failed",
        responseBody: safeResponseBody,
        usage: null,
        responseDigest: sha256(safeResponseBody),
        sourceDigest,
        occurredAt,
      });
    }

    const parsed = parseResponse(responseBody);
    if (parsed.kind === "invalid") return unknownOutcome("litellm-response", sourceDigest);
    return Object.freeze({
      kind: "succeeded",
      responseBody: parsed.safeResponseBody,
      usage: parsed.usage,
      responseDigest: sha256(parsed.safeResponseBody),
      sourceDigest,
      occurredAt,
    });
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

function parseResponse(body: Uint8Array):
  | Readonly<{
      kind: "valid";
      usage: readonly ModelUsageDimension[] | null;
      safeResponseBody: Uint8Array;
    }>
  | Readonly<{ kind: "invalid" }> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return Object.freeze({ kind: "invalid" });
  }
  if (!record(value) || !safeReference(value.id) ||
      !Array.isArray(value.choices) || value.choices.length < 1 || !record(value.choices[0])) {
    return Object.freeze({ kind: "invalid" });
  }
  const first = value.choices[0];
  if (!record(first.message) || first.message.role !== "assistant") {
    return Object.freeze({ kind: "invalid" });
  }
  const content = first.message.content === null ? "" : first.message.content;
  if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_RESPONSE_BYTES) {
    return Object.freeze({ kind: "invalid" });
  }
  const reasoning = first.message.reasoning_content;
  if (reasoning !== undefined && reasoning !== null &&
      (typeof reasoning !== "string" || Buffer.byteLength(reasoning, "utf8") > MAX_RESPONSE_BYTES)) {
    return Object.freeze({ kind: "invalid" });
  }
  const toolCalls = parseToolCalls(first.message.tool_calls);
  if (toolCalls === null || (content.length === 0 && toolCalls.length === 0)) {
    return Object.freeze({ kind: "invalid" });
  }
  const finishReason = first.finish_reason;
  if (finishReason !== undefined && finishReason !== null &&
      (typeof finishReason !== "string" || finishReason.length < 1 || finishReason.length > 64)) {
    return Object.freeze({ kind: "invalid" });
  }
  let usage: readonly ModelUsageDimension[] | null = null;
  let safeUsage: Readonly<{ prompt_tokens: number; completion_tokens: number }> | undefined;
  if (value.usage !== undefined) {
    if (!record(value.usage)) return Object.freeze({ kind: "invalid" });
    const input = safeInteger(value.usage.prompt_tokens);
    const output = safeInteger(value.usage.completion_tokens);
    if (input === null || output === null || input > BigInt(Number.MAX_SAFE_INTEGER) ||
        output > BigInt(Number.MAX_SAFE_INTEGER)) return Object.freeze({ kind: "invalid" });
    usage = Object.freeze([
      Object.freeze({ dimensionKey: "input_tokens", sourceUnit: "tokens", quantity: input }),
      Object.freeze({ dimensionKey: "output_tokens", sourceUnit: "tokens", quantity: output }),
    ]);
    safeUsage = Object.freeze({ prompt_tokens: Number(input), completion_tokens: Number(output) });
  }
  const safe = Object.freeze({
    id: value.id,
    choices: Object.freeze([Object.freeze({
      index: 0,
      message: Object.freeze({
        role: "assistant",
        content,
        ...(reasoning === undefined || reasoning === null ? {} : { reasoning_content: reasoning }),
        ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
      }),
      ...(finishReason === undefined || finishReason === null ? {} : { finish_reason: finishReason }),
    })]),
    ...(safeUsage === undefined ? {} : { usage: safeUsage }),
  });
  if (!jsonValue(safe)) return Object.freeze({ kind: "invalid" });
  return Object.freeze({
    kind: "valid",
    usage,
    safeResponseBody: new TextEncoder().encode(canonicalJson(safe)),
  });
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

function parseToolCalls(value: unknown): readonly ModelGatewayJsonValue[] | null {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 128) return null;
  const seen = new Set<string>();
  const calls: ModelGatewayJsonValue[] = [];
  for (const raw of value) {
    if (!record(raw) || raw.type !== "function" || !safeReference(raw.id) || seen.has(raw.id) ||
        !record(raw.function) || !safeToolName(raw.function.name) ||
        typeof raw.function.arguments !== "string" ||
        Buffer.byteLength(raw.function.arguments, "utf8") > 1024 * 1024) return null;
    let argumentsValue: unknown;
    try { argumentsValue = JSON.parse(raw.function.arguments); } catch { return null; }
    if (!jsonRecord(argumentsValue)) return null;
    const argumentsJson = canonicalJson(argumentsValue);
    calls.push(Object.freeze({
      id: raw.id,
      type: "function",
      function: Object.freeze({ name: raw.function.name, arguments: argumentsJson }),
    }));
    seen.add(raw.id);
  }
  return Object.freeze(calls);
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
