import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { LiteLlmChatAdapter } from
  "../../src/modules/model-gateway/infrastructure/http/litellm-chat-adapter.js";

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

    const prepared = adapter.prepare(request());
    const outcome = await terminal(prepared.stream({
      signal: AbortSignal.timeout(5_000),
      providerOperationKey: "invocation-1",
    }));

    expect(outcome).toMatchObject({
      kind: "succeeded",
      usage: [
        { dimensionKey: "input_tokens", sourceUnit: "tokens", quantity: 11n },
        { dimensionKey: "output_tokens", sourceUnit: "tokens", quantity: 3n },
      ],
      occurredAt: "2029-01-01T00:00:00.000Z",
    });
    expect(prepared.maximumDimensions).toEqual([
      expect.objectContaining({ dimensionKey: "input_tokens", sourceUnit: "tokens" }),
      { dimensionKey: "output_tokens", sourceUnit: "tokens", quantity: 128n },
    ]);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://litellm.internal.example/v1/chat/completions");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer example-litellm-key");
    expect(new Headers(init?.headers).get("idempotency-key")).toBe("invocation-1");
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

    await expect(terminal(timeout.prepare(request()).stream({
      signal: AbortSignal.timeout(5_000), providerOperationKey: "invocation-1",
    }))).resolves.toMatchObject({ kind: "outcome_unknown" });
    await expect(terminal(malformed.prepare(request()).stream({
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
    await expect(terminal(adapter.prepare(request()).stream({
      signal: AbortSignal.timeout(5_000), providerOperationKey: "invocation-1",
    }))).resolves.toMatchObject({ kind: "succeeded", usage: null });
  });

  it("turns a complete non-2xx response into terminal unavailable evidence without reflecting its body", async () => {
    const adapter = new LiteLlmChatAdapter({
      endpoint: "https://litellm.internal.example/v1",
      apiKey: "example-key",
      fetch: async () => new Response("provider-secret-detail", { status: 429 }),
    });

    const outcome = await terminal(adapter.prepare(request()).stream({
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
    const adapter = new LiteLlmChatAdapter({
      endpoint: "https://litellm.internal.example/v1",
      apiKey: "example-key",
      fetch: async () => new Response(),
    });
    expect(() => adapter.prepare({ ...request(), maxOutputTokens: 0 })).toThrowError(
      "MODEL_GATEWAY_CHAT_REQUEST_INVALID",
    );
    expect(() => adapter.prepare({ ...request(), model: "chat\nprimary" })).toThrowError(
      "MODEL_GATEWAY_CHAT_REQUEST_INVALID",
    );
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
