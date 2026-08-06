import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

describe("Model Gateway provider deployment", () => {
  it("ships a Direct-only default without implicitly configuring LiteLLM", async () => {
    const [environment, composeSource] = await Promise.all([
      readFile(".env.example", "utf8"),
      readFile("deploy/docker-compose.services.yml", "utf8"),
    ]);
    const compose = parse(composeSource) as {
      services?: Record<string, {
        environment?: Record<string, string>;
        volumes?: readonly Readonly<{
          source?: string;
          target?: string;
          read_only?: boolean;
        }>[];
      }>;
    };
    const gateway = compose.services?.["platform-model-gateway"];

    expect(environment).toMatch(
      /^PLATFORM_MODEL_GATEWAY_DIRECT_ENDPOINT=https:\/\/provider\.internal\/v1$/mu,
    );
    expect(environment).toMatch(
      /^PLATFORM_MODEL_GATEWAY_DIRECT_API_KEY_FILE=\/run\/secrets\/platform-model-gateway\/direct-api-key$/mu,
    );
    expect(environment).not.toMatch(/^PLATFORM_MODEL_GATEWAY_LITELLM_/mu);
    expect(gateway?.environment).toMatchObject({
      PLATFORM_MODEL_GATEWAY_DIRECT_ENDPOINT: "${PLATFORM_MODEL_GATEWAY_DIRECT_ENDPOINT:?required}",
      PLATFORM_MODEL_GATEWAY_DIRECT_API_KEY_FILE:
        "/run/secrets/platform-model-gateway/direct-api-key",
      PLATFORM_MODEL_GATEWAY_MTLS_PEERS_FILE:
        "/run/secrets/platform-model-gateway/inbound-peers.json",
      PLATFORM_MODEL_GATEWAY_RESPONSE_KEY_RING_FILE:
        "/run/secrets/platform-model-gateway/response-key-ring.json",
    });
    expect(Object.keys(gateway?.environment ?? {})).not.toContain(
      "PLATFORM_MODEL_GATEWAY_LITELLM_ENDPOINT",
    );
    expect(gateway?.volumes).toContainEqual({
      type: "bind",
      source: "${PLATFORM_MODEL_GATEWAY_SECRET_DIRECTORY:?required}",
      target: "/run/secrets/platform-model-gateway",
      read_only: true,
    });
  });
});
