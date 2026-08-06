import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { DirectOpenAiChatAdapter, LiteLlmChatAdapter } from
  "../../src/modules/model-gateway/infrastructure/http/openai-compatible-chat-adapter.js";
import { rateMaximumUsage, type RatingPolicyRevision } from
  "../../src/modules/credit/domain/usage-rating.js";

describe("LiteLlmChatAdapter", () => {
  it("maps one bounded typed chat request and records provider-reported usage", async () => {
    const fetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(
      async () => sse(
        { id: "chatcmpl-1", choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }] },
        { id: "chatcmpl-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        { id: "chatcmpl-1", choices: [], usage: { prompt_tokens: 11, completion_tokens: 3 } },
      ),
    );
    const adapter = new LiteLlmChatAdapter({
      endpoint: "https://litellm.internal.example/v1",
      apiKey: "example-litellm-key",
      fetch,
      timeoutMs: 5_000,
      clock: () => new Date("2029-01-01T00:00:00.000Z"),
    });

    const prepared = adapter.prepare(request(), authorization("litellm"));
    const outcome = await terminal(prepared.stream({
      signal: AbortSignal.timeout(5_000),
      providerOperationKey: "invocation-1",
    }));

    expect(outcome).toMatchObject({
      kind: "succeeded",
      usage: [
        { dimensionKey: "input_tokens", sourceUnit: "token", quantity: 11n },
        { dimensionKey: "output_tokens", sourceUnit: "token", quantity: 3n },
      ],
      occurredAt: "2029-01-01T00:00:00.000Z",
    });
    expect(prepared.maximumDimensions).toEqual([
      expect.objectContaining({ dimensionKey: "input_tokens", sourceUnit: "token" }),
      { dimensionKey: "output_tokens", sourceUnit: "token", quantity: 128n },
    ]);
    expect(() => rateMaximumUsage(tokenRatingPolicy(), prepared.maximumDimensions)).not.toThrow();
    const reportedUsage = outcome.kind === "succeeded" ? outcome.usage : null;
    if (reportedUsage !== null) {
      expect(() => rateMaximumUsage(tokenRatingPolicy(), reportedUsage)).not.toThrow();
    }
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://litellm.internal.example/v1/chat/completions");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer example-litellm-key");
    expect(new Headers(init?.headers).get("idempotency-key")).toBe("invocation-1");
    expect(new Headers(init?.headers).get("x-kokoro-provider-operation-key")).toBe("invocation-1");
    expect(JSON.parse(new TextDecoder().decode(init?.body as Uint8Array))).toMatchObject({
      model: "chat-primary",
      max_completion_tokens: 128,
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it("returns outcome_unknown for timeout or malformed 2xx and never fabricates usage", async () => {
    const timeout = new LiteLlmChatAdapter({
      endpoint: "https://litellm.internal.example/v1",
      apiKey: "example-key",
      fetch: async () => { throw new DOMException("timed out", "TimeoutError"); },
    });
    const malformed = new LiteLlmChatAdapter({
      endpoint: "https://litellm.internal.example/v1",
      apiKey: "example-key",
      fetch: async () => new Response("not-json", { status: 200 }),
    });

    await expect(terminal(timeout.prepare(request(), authorization("litellm")).stream({
      signal: AbortSignal.timeout(5_000), providerOperationKey: "invocation-1",
    }))).resolves.toMatchObject({ kind: "outcome_unknown" });
    await expect(terminal(malformed.prepare(request(), authorization("litellm")).stream({
      signal: AbortSignal.timeout(5_000), providerOperationKey: "invocation-1",
    }))).resolves.toMatchObject({ kind: "outcome_unknown" });
  });

  it("preserves a valid terminal response with missing usage as unavailable, never zero", async () => {
    const adapter = new LiteLlmChatAdapter({
      endpoint: "https://litellm.internal.example/v1",
      apiKey: "example-key",
      fetch: async () => sse(
        { id: "chatcmpl-1", choices: [{ index: 0, delta: { content: "hello" }, finish_reason: "stop" }] },
      ),
    });
    await expect(terminal(adapter.prepare(request(), authorization("litellm")).stream({
      signal: AbortSignal.timeout(5_000), providerOperationKey: "invocation-1",
    }))).resolves.toMatchObject({ kind: "succeeded", usage: null });
  });

  it("turns a complete non-2xx response into terminal unavailable evidence without reflecting its body", async () => {
    const adapter = new LiteLlmChatAdapter({
      endpoint: "https://litellm.internal.example/v1",
      apiKey: "example-key",
      fetch: async () => new Response("provider-secret-detail", { status: 429 }),
    });

    const outcome = await terminal(adapter.prepare(request(), authorization("litellm")).stream({
      signal: AbortSignal.timeout(5_000), providerOperationKey: "invocation-1",
    }));

    expect(outcome).toMatchObject({ kind: "failed", usage: null });
    expect(new TextDecoder().decode(outcome.kind === "failed" ? outcome.responseBody : new Uint8Array()))
      .not.toContain("provider-secret-detail");
    if (outcome.kind === "failed") {
      expect(outcome.responseDigest).toBe(
        createHash("sha256").update(outcome.responseBody).digest("hex"),
      );
      expect(outcome.sourceDigest).toBe(
        createHash("sha256").update("provider-secret-detail").digest("hex"),
      );
      expect(outcome.responseDigest).not.toBe(outcome.sourceDigest);
    }
  });

  it("rejects unsafe endpoints, unbounded output, and control characters before effect", () => {
    expect(() => new LiteLlmChatAdapter({
      endpoint: "http://litellm.internal.example/v1",
      apiKey: "example-key",
      fetch: async () => new Response(),
    })).toThrowError("MODEL_GATEWAY_LITELLM_ENDPOINT_INVALID");
    expect(() => new LiteLlmChatAdapter({
      endpoint: "https://litellm.internal.example/v1/chat/completions",
      apiKey: "example-key",
      fetch: async () => new Response(),
    })).toThrowError("MODEL_GATEWAY_LITELLM_ENDPOINT_INVALID");
    const adapter = new LiteLlmChatAdapter({
      endpoint: "https://litellm.internal.example/v1",
      apiKey: "example-key",
      fetch: async () => new Response(),
    });
    expect(() => adapter.prepare(
      { ...request(), maxOutputTokens: 0 },
      authorization("litellm"),
    )).toThrowError(
      "MODEL_GATEWAY_CHAT_REQUEST_INVALID",
    );
    expect(() => adapter.prepare(
      { ...request(), model: "chat\nprimary" },
      authorization("litellm"),
    )).toThrowError(
      "MODEL_GATEWAY_CHAT_REQUEST_INVALID",
    );
  });
});

describe("DirectOpenAiChatAdapter", () => {
  it("maps a Gateway alias to one direct provider model without LiteLLM header forwarding", async () => {
    const fetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(
      async () => sse(
        { id: "chatcmpl-1", choices: [{ index: 0, delta: { content: "hello" }, finish_reason: "stop" }] },
        { id: "chatcmpl-1", choices: [], usage: { prompt_tokens: 2, completion_tokens: 1 } },
      ),
    );
    const adapter = new DirectOpenAiChatAdapter({
      endpoint: "https://provider.internal.example/v1",
      apiKey: "example-provider-key",
      fetch,
    });

    const prepared = adapter.prepare(request(), authorization("direct"));
    await terminal(prepared.stream({
      signal: AbortSignal.timeout(5_000),
      providerOperationKey: "invocation-direct-1",
    }));

    expect(prepared.gatewayModel).toBe("chat-primary");
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://provider.internal.example/v1/chat/completions");
    const headers = new Headers(init?.headers);
    expect(headers.get("idempotency-key")).toBe("invocation-direct-1");
    expect(headers.has("x-kokoro-provider-operation-key")).toBe(false);
    expect(JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)).model)
      .toBe("provider-chat-v1");
  });

  it("rejects an authorization/request alias mismatch before a provider effect", () => {
    const fetch = vi.fn(async () => new Response());
    const adapter = new DirectOpenAiChatAdapter({
      endpoint: "https://provider.internal.example/v1",
      apiKey: "example-provider-key",
      fetch,
    });

    expect(() => adapter.prepare(
      { ...request(), model: "chat-other" },
      authorization("direct"),
    )).toThrowError("MODEL_GATEWAY_AUTHORIZATION_ROUTE_MISMATCH");
    expect(fetch).not.toHaveBeenCalled();
  });
});

function sse(...chunks: readonly unknown[]): Response {
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function terminal(source: AsyncIterable<{
  kind: string;
  outcome?: import("../../src/modules/model-gateway/application/model-gateway-service.js").ModelGatewayProviderOutcome;
}>) {
  for await (const event of source) if (event.kind === "terminal" && event.outcome !== undefined) {
    return event.outcome;
  }
  throw new Error("terminal missing");
}

function request() {
  return {
    protocol: "openai.chat.completions.v1" as const,
    model: "chat-primary",
    messages: [{ role: "user" as const, content: "hello", toolCalls: [] }],
    maxOutputTokens: 128,
    tools: [],
    toolChoice: "none" as const,
  };
}

function authorization(adapterKind: "direct" | "litellm") {
  return {
    modelAuthorizationHandle: `model-authorization:sha256:${"f".repeat(64)}`,
    siteId: "site-a",
    executionManifestRef: "manifest-a",
    authorizationSegmentRef: "segment-a",
    authorizedGatewayModel: "chat-primary",
    providerModel: "provider-chat-v1",
    adapterKind,
    expiresAt: "2030-01-01T00:00:00.000Z",
  } as const;
}

function tokenRatingPolicy(): RatingPolicyRevision {
  return Object.freeze({
    ratingPolicyRevisionRef: "rating-policy:chat-v1",
    customerUnit: "credit_micros",
    chargeableAttemptOutcomes: Object.freeze(["succeeded" as const, "failed_after_effect" as const]),
    minimumAmount: 0n,
    rules: Object.freeze([
      Object.freeze({ dimensionKey: "input_tokens", sourceUnit: "token",
        quantum: 1_000n, amountPerQuantum: 2n, required: true }),
      Object.freeze({ dimensionKey: "output_tokens", sourceUnit: "token",
        quantum: 1_000n, amountPerQuantum: 5n, required: true }),
    ]),
  });
}
