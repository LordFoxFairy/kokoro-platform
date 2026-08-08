import { describe, expect, it, vi } from "vitest";
import {
  SiteProviderEffectError,
  SiteProviderRpcAdapter,
  sitePromotionCommandDigest,
  siteTrafficStopCommandDigest,
} from "../../src/modules/site/infrastructure/rpc/site-provider-rpc.js";

describe("SiteProviderRpcAdapter", () => {
  it("sends a bounded authenticated idempotent RPC and preserves exact provider evidence", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const command = promotionCommand();
    const body = JSON.stringify({ status: "ready", deploymentRef: "deployment_02",
      observedAt: "2026-07-30T10:01:00.000Z", operationKey: command.operationKey,
      siteRef: command.siteRef, providerProjectRef: command.providerProjectRef,
      releaseRef: command.releaseRef, webArtifactDigest: command.webArtifactDigest,
      releaseManifestDigest: command.releaseManifestDigest,
      certificationDigest: command.certificationDigest, environment: command.environment,
      region: command.region, audience: command.audience,
      sessionContractRevision: command.sessionContractRevision,
      commandDigest: sitePromotionCommandDigest(command) });
    const provider = new SiteProviderRpcAdapter({ namespace: "vercel",
      endpoint: "https://deploy.internal.example/control", bearerToken: "token-secret", timeoutMs: 1_000,
      fetch: async (url, init) => { if (init === undefined) throw new Error("init required");
        calls.push({ url: String(url), init }); return new Response(body, {
        status: 200, headers: { "content-type": "application/json", "content-length": String(body.length) },
      }); } });
    const result = await provider.promote(command, new AbortController().signal);
    expect(calls[0]?.url).toBe("https://deploy.internal.example/control/v1/site-runtime/promote");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer token-secret");
    expect(new Headers(calls[0]?.init.headers).get("idempotency-key")).toBe("operation_01");
    expect(result).toMatchObject({ status: "ready", deploymentRef: "deployment_02",
      observedAt: "2026-07-30T10:01:00.000Z", operationKey: command.operationKey,
      releaseRef: command.releaseRef, webArtifactDigest: command.webArtifactDigest,
      commandDigest: sitePromotionCommandDigest(command) });
    expect(result.payloadDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects a ready observation that is not authored for the exact candidate command", async () => {
    const command = promotionCommand();
    const response = { status: "ready", deploymentRef: "deployment_02",
      observedAt: "2026-07-30T10:01:00.000Z", operationKey: command.operationKey,
      siteRef: command.siteRef, providerProjectRef: command.providerProjectRef,
      releaseRef: "release_wrong", webArtifactDigest: command.webArtifactDigest,
      releaseManifestDigest: command.releaseManifestDigest,
      certificationDigest: command.certificationDigest, environment: command.environment,
      region: command.region, audience: command.audience,
      sessionContractRevision: command.sessionContractRevision,
      commandDigest: sitePromotionCommandDigest(command) };
    const provider = new SiteProviderRpcAdapter({ namespace: "vercel",
      endpoint: "https://deploy.internal.example/control", bearerToken: "token-secret", timeoutMs: 1_000,
      fetch: async () => new Response(JSON.stringify(response), {
        status: 200, headers: { "content-type": "application/json" },
      }) });

    await expect(provider.promote(command, new AbortController().signal))
      .rejects.toMatchObject({ code: "PROVIDER_RPC_RESPONSE_BINDING_MISMATCH" });
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

  it("propagates process abort to the provider call without translating it into delivery failure", async () => {
    const controller = new AbortController();
    const provider = new SiteProviderRpcAdapter({ namespace: "vercel",
      endpoint: "https://deploy.internal.example", bearerToken: "token-secret", timeoutMs: 1_000,
      fetch: async (_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }) });
    const call = provider.observeTrafficStop(trafficCommand(), controller.signal);

    controller.abort(new DOMException("draining", "AbortError"));

    await expect(call).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects traffic-stop evidence for a different deployment", async () => {
    const command = trafficCommand();
    const response = { ...trafficEvidence(command), deploymentRef: "deployment_wrong",
      status: "stopped", observedAt: "2026-07-30T10:01:00.000Z" };
    const provider = new SiteProviderRpcAdapter({ namespace: "vercel",
      endpoint: "https://deploy.internal.example/control", bearerToken: "token-secret", timeoutMs: 1_000,
      fetch: async () => new Response(JSON.stringify(response), {
        status: 200, headers: { "content-type": "application/json" },
      }) });

    await expect(provider.stopTraffic(command, new AbortController().signal))
      .rejects.toMatchObject({ code: "PROVIDER_RPC_RESPONSE_BINDING_MISMATCH" });
  });

  it("bounds a provider call with its configured timeout", async () => {
    vi.useFakeTimers();
    try {
      const provider = new SiteProviderRpcAdapter({ namespace: "vercel",
        endpoint: "https://deploy.internal.example", bearerToken: "token-secret", timeoutMs: 100,
        fetch: async (_url, init) => new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }) });
      const call = provider.observeTrafficStop(trafficCommand(), new AbortController().signal);
      const timeoutExpectation = expect(call).rejects.toMatchObject({ code: "PROVIDER_RPC_TIMEOUT" });

      await vi.advanceTimersByTimeAsync(100);

      await timeoutExpectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects insecure or ambiguous provider endpoints at composition time", () => {
    expect(() => new SiteProviderRpcAdapter({ namespace: "vercel", endpoint: "http://127.0.0.1",
      bearerToken: "token-secret", timeoutMs: 1_000 })).toThrow("SITE_PROVIDER_RPC_ENDPOINT_INVALID");
  });
});

function trafficCommand() {
  return { operationKey: "operation_01", siteRef: "site_01",
    providerProjectRef: "project_01", deploymentRef: "deployment_01", environment: "staging",
    region: "us-east-1" } as const;
}

function promotionCommand() {
  return { operationKey: "operation_01", siteRef: "site_01",
    providerProjectRef: "project_01", releaseRef: "release_02", webArtifactDigest: "a".repeat(64),
    releaseManifestDigest: "b".repeat(64), certificationDigest: "c".repeat(64),
    environment: "staging", region: "us-east-1", audience: "site-product",
    sessionContractRevision: "browser-v3" } as const;
}

function trafficEvidence(command: ReturnType<typeof trafficCommand>) {
  return { operationKey: command.operationKey, siteRef: command.siteRef,
    providerProjectRef: command.providerProjectRef, deploymentRef: command.deploymentRef,
    environment: command.environment, region: command.region,
    commandDigest: siteTrafficStopCommandDigest(command) } as const;
}
