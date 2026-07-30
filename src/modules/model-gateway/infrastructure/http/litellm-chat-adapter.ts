import { createHash } from "node:crypto";
import type {
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
      messages: request.messages.map((message) => Object.freeze({ ...message })),
      max_completion_tokens: request.maxOutputTokens,
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
        sourceDigest: sha256(safeResponseBody),
        occurredAt,
      });
    }

    const parsed = parseResponse(responseBody);
    if (parsed.kind === "invalid") return unknownOutcome("litellm-response", sourceDigest);
    return Object.freeze({
      kind: "succeeded",
      responseBody,
      usage: parsed.usage,
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
    !Array.isArray(request.messages) || request.messages.length < 1 || request.messages.length > 512
  ) throw new Error("MODEL_GATEWAY_CHAT_REQUEST_INVALID");
  let contentBytes = 0;
  for (const message of request.messages) {
    if (
      message === null || typeof message !== "object" ||
      !["system", "user", "assistant"].includes(message.role) ||
      typeof message.content !== "string" || message.content.length < 1 ||
      hasControlCharacter(message.role)
    ) throw new Error("MODEL_GATEWAY_CHAT_REQUEST_INVALID");
    contentBytes += Buffer.byteLength(message.content, "utf8");
    if (contentBytes > MAX_REQUEST_BYTES) throw new Error("MODEL_GATEWAY_CHAT_REQUEST_TOO_LARGE");
  }
}

function parseResponse(body: Uint8Array):
  | Readonly<{ kind: "valid"; usage: readonly ModelUsageDimension[] | null }>
  | Readonly<{ kind: "invalid" }> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return Object.freeze({ kind: "invalid" });
  }
  if (!record(value) || typeof value.id !== "string" || value.id.length < 1 ||
      !Array.isArray(value.choices) || value.choices.length < 1) {
    return Object.freeze({ kind: "invalid" });
  }
  if (value.usage === undefined) return Object.freeze({ kind: "valid", usage: null });
  if (!record(value.usage)) return Object.freeze({ kind: "invalid" });
  const input = safeInteger(value.usage.prompt_tokens);
  const output = safeInteger(value.usage.completion_tokens);
  if (input === null || output === null) return Object.freeze({ kind: "invalid" });
  return Object.freeze({
    kind: "valid",
    usage: Object.freeze([
      Object.freeze({ dimensionKey: "input_tokens", sourceUnit: "tokens", quantity: input }),
      Object.freeze({ dimensionKey: "output_tokens", sourceUnit: "tokens", quantity: output }),
    ]),
  });
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
