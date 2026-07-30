import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { LiteLlmChatAdapter } from
  "../../src/modules/model-gateway/infrastructure/http/litellm-chat-adapter.js";

describe("LiteLlmChatAdapter", () => {
  it("maps one bounded typed chat request and records provider-reported usage", async () => {
    const fetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(
      async () => new Response(JSON.stringify({
      id: "chatcmpl-1",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "hello" } }],
      usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const adapter = new LiteLlmChatAdapter({
      endpoint: "https://litellm.internal.example/v1",
      apiKey: "example-litellm-key",
      fetch,
      timeoutMs: 5_000,
      clock: () => new Date("2029-01-01T00:00:00.000Z"),
    });

    const prepared = adapter.prepare(request());
    const outcome = await prepared.invoke({
      signal: AbortSignal.timeout(5_000),
      providerOperationKey: "invocation-1",
    });

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
      stream: false,
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

    await expect(timeout.prepare(request()).invoke({
      signal: AbortSignal.timeout(5_000), providerOperationKey: "invocation-1",
    })).resolves.toMatchObject({ kind: "outcome_unknown" });
    await expect(malformed.prepare(request()).invoke({
      signal: AbortSignal.timeout(5_000), providerOperationKey: "invocation-1",
    })).resolves.toMatchObject({ kind: "outcome_unknown" });
  });

  it("preserves a valid terminal response with missing usage as unavailable, never zero", async () => {
    const adapter = new LiteLlmChatAdapter({
      endpoint: "https://litellm.internal.example/v1",
      apiKey: "example-key",
      fetch: async () => new Response(JSON.stringify({
        id: "chatcmpl-1",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "hello" } }],
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });
    await expect(adapter.prepare(request()).invoke({
      signal: AbortSignal.timeout(5_000), providerOperationKey: "invocation-1",
    })).resolves.toMatchObject({ kind: "succeeded", usage: null });
  });

  it("turns a complete non-2xx response into terminal unavailable evidence without reflecting its body", async () => {
    const adapter = new LiteLlmChatAdapter({
      endpoint: "https://litellm.internal.example/v1",
      apiKey: "example-key",
      fetch: async () => new Response("provider-secret-detail", { status: 429 }),
    });

    const outcome = await adapter.prepare(request()).invoke({
      signal: AbortSignal.timeout(5_000), providerOperationKey: "invocation-1",
    });

    expect(outcome).toMatchObject({ kind: "failed", usage: null });
    expect(new TextDecoder().decode(outcome.kind === "failed" ? outcome.responseBody : new Uint8Array()))
      .not.toContain("provider-secret-detail");
    if (outcome.kind === "failed") {
      expect(outcome.sourceDigest).toBe(createHash("sha256").update(outcome.responseBody).digest("hex"));
    }
  });

  it("rejects unsafe endpoints, streaming, unbounded output, and control characters before effect", () => {
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

function request() {
  return {
    protocol: "openai.chat.completions.v1" as const,
    model: "chat-primary",
    messages: [{ role: "user" as const, content: "hello" }],
    maxOutputTokens: 128,
  };
}
