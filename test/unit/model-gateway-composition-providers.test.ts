import { describe, expect, it } from "vitest";
import { loadModelGatewayProviderRouter } from
  "../../src/process/model-gateway-composition.js";

describe("Model Gateway provider composition", () => {
  it("starts with a Direct adapter and no LiteLLM configuration", async () => {
    const reads: string[] = [];
    const router = await loadModelGatewayProviderRouter({
      PLATFORM_MODEL_GATEWAY_DIRECT_ENDPOINT: "https://provider.internal.example/v1",
      PLATFORM_MODEL_GATEWAY_DIRECT_API_KEY_FILE: "/private/direct-key",
    }, 5_000, async (path) => {
      reads.push(path);
      if (path === "/private/direct-key") return "direct-key\n";
      throw new Error("unexpected read");
    });

    expect(router.prepare(request(), authorization("direct")).gatewayModel).toBe("chat-primary");
    expect(() => router.prepare(request(), authorization("litellm")))
      .toThrowError("MODEL_GATEWAY_PROVIDER_ADAPTER_UNAVAILABLE");
    expect(reads).toEqual(["/private/direct-key"]);
  });

  it("starts with a LiteLLM adapter and no Direct configuration", async () => {
    const reads: string[] = [];
    const router = await loadModelGatewayProviderRouter({
      PLATFORM_MODEL_GATEWAY_LITELLM_ENDPOINT: "https://litellm.internal.example/v1",
      PLATFORM_MODEL_GATEWAY_LITELLM_API_KEY_FILE: "/private/litellm-key",
    }, 5_000, async (path) => {
      reads.push(path);
      return "litellm-key\n";
    });

    expect(router.prepare(request(), authorization("litellm")).gatewayModel).toBe("chat-primary");
    expect(() => router.prepare(request(), authorization("direct")))
      .toThrowError("MODEL_GATEWAY_PROVIDER_ADAPTER_UNAVAILABLE");
    expect(reads).toEqual(["/private/litellm-key"]);
  });

  it("starts with both exact adapters without a routing map", async () => {
    const reads: string[] = [];
    const router = await loadModelGatewayProviderRouter({
      PLATFORM_MODEL_GATEWAY_DIRECT_ENDPOINT: "https://provider.internal.example/v1",
      PLATFORM_MODEL_GATEWAY_DIRECT_API_KEY_FILE: "/private/direct-key",
      PLATFORM_MODEL_GATEWAY_LITELLM_ENDPOINT: "https://litellm.internal.example/v1",
      PLATFORM_MODEL_GATEWAY_LITELLM_API_KEY_FILE: "/private/litellm-key",
    }, 5_000, async (path) => {
      reads.push(path);
      return path.includes("direct") ? "direct-key\n" : "litellm-key\n";
    });

    expect(router.prepare(request(), authorization("direct")).gatewayModel).toBe("chat-primary");
    expect(router.prepare(request(), authorization("litellm")).gatewayModel).toBe("chat-primary");
    expect(reads.sort()).toEqual(["/private/direct-key", "/private/litellm-key"]);
  });

  it("rejects missing and partially configured adapters", async () => {
    const read = async () => "unused";
    await expect(loadModelGatewayProviderRouter({}, 5_000, read))
      .rejects.toThrowError("PLATFORM_MODEL_GATEWAY_PROVIDER_ADAPTER_REQUIRED");
    await expect(loadModelGatewayProviderRouter({
      PLATFORM_MODEL_GATEWAY_LITELLM_ENDPOINT: "https://litellm.internal.example/v1",
    }, 5_000, read)).rejects.toThrowError("PLATFORM_MODEL_GATEWAY_LITELLM_CONFIG_INVALID");
    await expect(loadModelGatewayProviderRouter({
      PLATFORM_MODEL_GATEWAY_DIRECT_ENDPOINT: "https://provider.internal.example/v1",
    }, 5_000, read)).rejects.toThrowError("PLATFORM_MODEL_GATEWAY_DIRECT_CONFIG_INVALID");
    await expect(loadModelGatewayProviderRouter({
      PLATFORM_MODEL_GATEWAY_DIRECT_API_KEY_FILE: "/private/direct-key",
    }, 5_000, read)).rejects.toThrowError("PLATFORM_MODEL_GATEWAY_DIRECT_CONFIG_INVALID");
  });
});

function request() {
  return {
    protocol: "openai.chat.completions.v1" as const,
    model: "chat-primary",
    messages: [{ role: "user" as const, content: "hello", toolCalls: [] }],
    maxOutputTokens: 32,
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
