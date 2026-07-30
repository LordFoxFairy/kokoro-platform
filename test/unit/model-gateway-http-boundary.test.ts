import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createModelGatewayHttpBoundary } from
  "../../src/modules/model-gateway/interfaces/http/model-gateway-http-boundary.js";

describe("Model Gateway HTTP boundary", () => {
  it("accepts only opaque authorization and returns provider bytes with safe receipt headers", async () => {
    let received: unknown;
    const boundary = createModelGatewayHttpBoundary({
      service: { invoke: async (input: unknown) => {
        received = input;
        return {
          kind: "succeeded" as const, invocationRef: "invocation-1", attemptRef: "attempt-1",
          responseBody: new TextEncoder().encode('{"id":"provider-response"}'), replayed: false,
        };
      }, reconcileOutcome: async () => { throw new Error("not used"); } },
    });
    const response = await boundary({
      method: "POST", path: "/internal/v1/model-invocations",
      contentType: "application/json",
      body: new TextEncoder().encode(JSON.stringify(requestBody())),
      callerScopes: ["invoke"],
      signal: AbortSignal.timeout(1_000),
    });

    expect(response).toMatchObject({ status: 200, contentType: "application/json" });
    expect(response.headers).toMatchObject({
      "x-kokoro-model-invocation-ref": "invocation-1",
      "x-kokoro-model-attempt-ref": "attempt-1",
      "x-kokoro-model-outcome": "succeeded",
    });
    expect(received).toMatchObject({
      modelAuthorizationHandle: requestBody().modelAuthorizationHandle,
      producerGeneration: 1n,
    });
    expect(received).not.toHaveProperty("siteId");
  });

  it("rejects ambient site, account and credit fields instead of trusting them", async () => {
    const boundary = createModelGatewayHttpBoundary({
      service: {
        invoke: async () => { throw new Error("must not run"); },
        reconcileOutcome: async () => { throw new Error("must not run"); },
      },
    });
    for (const forbidden of ["siteId", "accountId", "creditHoldRef"]) {
      const response = await boundary({
        method: "POST", path: "/internal/v1/model-invocations",
        contentType: "application/json",
        body: new TextEncoder().encode(JSON.stringify({ ...requestBody(), [forbidden]: "attacker" })),
        callerScopes: ["invoke"],
        signal: AbortSignal.timeout(1_000),
      });
      expect(response.status).toBe(400);
    }
  });

  it("maps outcome_unknown without fabricating provider usage or a zero response", async () => {
    const boundary = createModelGatewayHttpBoundary({
      service: { invoke: async () => ({
        kind: "outcome_unknown" as const, invocationRef: "invocation-1",
        attemptRef: "attempt-1", replayed: false,
      }), reconcileOutcome: async () => { throw new Error("not used"); } },
    });
    const response = await boundary({
      method: "POST", path: "/internal/v1/model-invocations",
      contentType: "application/json",
      body: new TextEncoder().encode(JSON.stringify(requestBody())),
      callerScopes: ["invoke"],
      signal: AbortSignal.timeout(1_000),
    });
    expect(response.status).toBe(202);
    expect(new TextDecoder().decode(response.body)).toBe('{"kind":"outcome_unknown"}');
  });

  it("exposes reconciliation only to a separately scoped trusted mTLS peer", async () => {
    let reconciled = false;
    const boundary = createModelGatewayHttpBoundary({
      service: {
        invoke: async () => { throw new Error("not used"); },
        reconcileOutcome: async () => {
          reconciled = true;
          return {
            kind: "succeeded" as const, invocationRef: "invocation-1", attemptRef: "attempt-1",
            responseBody: new TextEncoder().encode('{"id":"provider-response"}'), replayed: false,
          };
        },
      },
    });
    const providerResponse = '{"id":"provider-response","choices":[{"index":0}]}';
    const body = new TextEncoder().encode(JSON.stringify({
      modelAuthorizationHandle: requestBody().modelAuthorizationHandle,
      logicalCallRef: "logical-call-1",
      requestDigest: "a".repeat(64),
      outcome: {
        kind: "succeeded",
        responseBodyBase64url: Buffer.from(providerResponse).toString("base64url"),
        usage: [{ dimensionKey: "input_tokens", sourceUnit: "tokens", quantity: "2" }],
        sourceDigest: createHash("sha256").update(providerResponse).digest("hex"),
        occurredAt: "2029-01-01T00:00:01.000Z",
      },
    }));
    const denied = await boundary({
      method: "POST", path: "/internal/v1/model-invocations/reconcile",
      contentType: "application/json", body, callerScopes: ["invoke"],
      signal: AbortSignal.timeout(1_000),
    });
    expect(denied.status).toBe(403);
    expect(reconciled).toBe(false);

    const accepted = await boundary({
      method: "POST", path: "/internal/v1/model-invocations/reconcile",
      contentType: "application/json", body, callerScopes: ["reconcile"],
      signal: AbortSignal.timeout(1_000),
    });
    expect(accepted.status).toBe(200);
    expect(reconciled).toBe(true);
  });

  it("rejects reconciliation bytes that are not a certified provider response", async () => {
    let reconciled = false;
    const boundary = createModelGatewayHttpBoundary({
      service: {
        invoke: async () => { throw new Error("not used"); },
        reconcileOutcome: async () => {
          reconciled = true;
          throw new Error("must not run");
        },
      },
    });
    const providerResponse = '{"arbitrary":"bytes"}';
    const response = await boundary({
      method: "POST", path: "/internal/v1/model-invocations/reconcile",
      contentType: "application/json", callerScopes: ["reconcile"],
      signal: AbortSignal.timeout(1_000),
      body: new TextEncoder().encode(JSON.stringify({
        modelAuthorizationHandle: requestBody().modelAuthorizationHandle,
        logicalCallRef: "logical-call-1", requestDigest: "a".repeat(64),
        outcome: {
          kind: "succeeded",
          responseBodyBase64url: Buffer.from(providerResponse).toString("base64url"),
          usage: null,
          sourceDigest: createHash("sha256").update(providerResponse).digest("hex"),
          occurredAt: "2029-01-01T00:00:01.000Z",
        },
      })),
    });
    expect(response.status).toBe(400);
    expect(reconciled).toBe(false);
  });
});

function requestBody() {
  return {
    modelAuthorizationHandle: `model-authorization:sha256:${"f".repeat(64)}`,
    logicalCallRef: "logical-call-1", attemptRef: "attempt-1",
    producerContext: "ga-run-1", producerGeneration: "1",
    request: {
      protocol: "openai.chat.completions.v1",
      model: "chat-primary",
      messages: [{ role: "user", content: "hello" }],
      maxOutputTokens: 128,
    },
  };
}
