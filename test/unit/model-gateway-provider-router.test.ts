import { describe, expect, it, vi } from "vitest";
import {
  ModelGatewayProviderRouter,
  type ModelGatewayProviderPort,
  type ModelGatewayRequest,
} from "../../src/modules/model-gateway/application/model-gateway-service.js";

describe("ModelGatewayProviderRouter", () => {
  it("selects only the adapter frozen by authorization", () => {
    const direct = adapter("direct-model");
    const litellm = adapter("litellm-model");
    const router = new ModelGatewayProviderRouter({ direct, litellm });

    expect(router.prepare(request(), authorization("direct")).gatewayModel).toBe("direct-model");
    expect(direct.prepare).toHaveBeenCalledOnce();
    expect(direct.prepare).toHaveBeenCalledWith(request(), authorization("direct"));
    expect(litellm.prepare).not.toHaveBeenCalled();
  });

  it("fails closed when the authorized adapter is not configured", () => {
    const litellm = adapter("litellm-model");
    const router = new ModelGatewayProviderRouter({ litellm });

    expect(() => router.prepare(request(), authorization("direct")))
      .toThrowError("MODEL_GATEWAY_PROVIDER_ADAPTER_UNAVAILABLE");
    expect(litellm.prepare).not.toHaveBeenCalled();
  });

  it("rejects a request alias that differs from the frozen authorization before an effect", () => {
    const direct = adapter("direct-model");
    const router = new ModelGatewayProviderRouter({ direct });

    expect(() => router.prepare({ ...request(), model: "chat-other" }, authorization("direct")))
      .toThrowError("MODEL_GATEWAY_AUTHORIZATION_ROUTE_MISMATCH");
    expect(direct.prepare).not.toHaveBeenCalled();
  });
});

function adapter(gatewayModel: string) {
  const prepare = vi.fn<ModelGatewayProviderPort["prepare"]>(() => ({
      gatewayModel,
      requestDigest: "a".repeat(64),
      maximumDimensions: [],
      stream: async function* () {},
    }));
  return { prepare } satisfies ModelGatewayProviderPort;
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

function request(): ModelGatewayRequest {
  return {
    protocol: "openai.chat.completions.v1",
    model: "chat-primary",
    messages: [{ role: "user", content: "hello", toolCalls: [] }],
    maxOutputTokens: 32,
    tools: [],
    toolChoice: "none",
  };
}
