import { describe, expect, it } from "vitest";
import {
  SiteProviderEffectError,
  SiteProviderRpcAdapter,
} from "../../src/modules/site/infrastructure/rpc/site-provider-rpc.js";

describe("SiteProviderRpcAdapter", () => {
  it("sends a bounded authenticated idempotent RPC and preserves exact provider evidence", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const body = JSON.stringify({ status: "ready", deploymentRef: "deployment_02",
      observedAt: "2026-07-30T10:01:00.000Z" });
    const provider = new SiteProviderRpcAdapter({ namespace: "vercel",
      endpoint: "https://deploy.internal.example/control", bearerToken: "token-secret", timeoutMs: 1_000,
      fetch: async (url, init) => { if (init === undefined) throw new Error("init required");
        calls.push({ url: String(url), init }); return new Response(body, {
        status: 200, headers: { "content-type": "application/json", "content-length": String(body.length) },
      }); } });
    const result = await provider.promote({ operationKey: "operation_01", siteRef: "site_01",
      providerProjectRef: "project_01", releaseRef: "release_02", webArtifactDigest: "a".repeat(64),
      releaseManifestDigest: "b".repeat(64), certificationDigest: "c".repeat(64),
      environment: "production", region: "us-east-1" }, new AbortController().signal);
    expect(calls[0]?.url).toBe("https://deploy.internal.example/control/v1/site-runtime/promote");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer token-secret");
    expect(new Headers(calls[0]?.init.headers).get("idempotency-key")).toBe("operation_01");
    expect(result).toMatchObject({ status: "ready", deploymentRef: "deployment_02",
      observedAt: "2026-07-30T10:01:00.000Z" });
    expect(result.payloadDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("classifies an indeterminate upstream failure for durable reconciliation", async () => {
    const provider = new SiteProviderRpcAdapter({ namespace: "vercel",
      endpoint: "https://deploy.internal.example", bearerToken: "token-secret", timeoutMs: 1_000,
      fetch: async () => new Response("unavailable", { status: 503 }) });
    await expect(provider.observeTrafficStop({ operationKey: "operation_01", siteRef: "site_01",
      providerProjectRef: "project_01", deploymentRef: "deployment_01", environment: "production",
      region: "us-east-1" }, new AbortController().signal)).rejects.toMatchObject({
      outcome: "unknown", code: "PROVIDER_RPC_UNAVAILABLE",
    } satisfies Partial<SiteProviderEffectError>);
  });

  it("rejects insecure or ambiguous provider endpoints at composition time", () => {
    expect(() => new SiteProviderRpcAdapter({ namespace: "vercel", endpoint: "http://127.0.0.1",
      bearerToken: "token-secret", timeoutMs: 1_000 })).toThrow("SITE_PROVIDER_RPC_ENDPOINT_INVALID");
  });
});
