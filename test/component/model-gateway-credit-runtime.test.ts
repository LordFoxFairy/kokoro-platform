import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { createModelGatewayCreditFixtureResult } from
  "../fixtures/model-gateway-credit-runtime.js";

const fixtureSource = readFileSync(new URL(
  "../fixtures/model-gateway-credit-runtime.ts",
  import.meta.url,
), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

function liteLlmConfig(name: string): Record<string, unknown> {
  const source = readFileSync(new URL(`../../kokoro-litellm/config/${name}`, import.meta.url), "utf8");
  const config: unknown = parse(source);
  expect(config).toBeTypeOf("object");
  expect(config).not.toBeNull();
  return config as Record<string, unknown>;
}

describe("Model Gateway Credit production runtime fixture", () => {
  it("exports a bounded private handoff for an Agent-owned Gateway probe", async () => {
    const fixtureModule = await import("../fixtures/model-gateway-credit-runtime.js");
    const createServerResult = (fixtureModule as unknown as Record<string, unknown>)
      .createModelGatewayCreditServerResult;
    const startServer = (fixtureModule as unknown as Record<string, unknown>)
      .startModelGatewayCreditServer;
    const parseCommand = (fixtureModule as unknown as Record<string, unknown>)
      .parseModelGatewayCreditFixtureCommand;
    expect(typeof createServerResult).toBe("function");
    expect(typeof startServer).toBe("function");
    expect(typeof parseCommand).toBe("function");
    if (typeof parseCommand === "function") {
      expect(parseCommand([])).toBe("run");
      expect(parseCommand(["serve"])).toBe("serve");
      expect(() => parseCommand(["serve", "extra"]))
        .toThrow("MODEL_GATEWAY_CREDIT_FIXTURE_COMMAND_INVALID");
    }
    if (typeof createServerResult !== "function") return;
    const valid = {
      baseUrl: "https://127.0.0.1:43901",
      serverName: "localhost",
      certificateAuthorityFile: "/private/gateway-ca.pem",
      agentCertificateFile: "/private/agent.pem",
      agentPrivateKeyFile: "/private/agent-key.pem",
    };
    expect(createServerResult(valid)).toEqual({
      schemaVersion: 1,
      kind: "model-gateway-credit-server",
      ...valid,
    });
    expect(() => createServerResult({ ...valid, baseUrl: "http://127.0.0.1:43901" }))
      .toThrow("MODEL_GATEWAY_CREDIT_SERVER_RESULT_INVALID");
    expect(() => createServerResult({ ...valid, agentPrivateKeyFile: "relative.pem" }))
      .toThrow("MODEL_GATEWAY_CREDIT_SERVER_RESULT_INVALID");
  });

  it("returns only bounded effect and replay evidence", () => {
    const valid = {
      firstCompleted: true,
      replayCompleted: true,
      replayAttached: true,
      sameInvocation: true,
      inputTokens: 5,
      outputTokens: 3,
    } as const;
    expect(createModelGatewayCreditFixtureResult(valid)).toEqual({
      schemaVersion: 1,
      kind: "model-gateway-credit-runtime",
      ...valid,
    });
    for (const flag of ["firstCompleted", "replayCompleted", "replayAttached", "sameInvocation"] as const) {
      expect(() => createModelGatewayCreditFixtureResult({ ...valid, [flag]: false }))
        .toThrowError("MODEL_GATEWAY_CREDIT_FIXTURE_RESULT_INVALID");
    }
    expect(() => createModelGatewayCreditFixtureResult({
      ...valid,
      inputTokens: 0,
    })).toThrowError("MODEL_GATEWAY_CREDIT_FIXTURE_RESULT_INVALID");
  });

  it("uses the production composition and generated Connect client without direct SQL", () => {
    expect(fixtureSource).toContain("createModelGatewayProductionComposition");
    expect(fixtureSource).toContain("createPostgresModelGatewayDatabase");
    expect(fixtureSource).toContain("createConnectTransport");
    expect(fixtureSource).toContain("client.invokeModel");
    expect(fixtureSource).toContain('"genpkey", "-algorithm", "RSA"');
    expect(fixtureSource).not.toContain('"genrsa"');
    expect(fixtureSource).not.toMatch(/(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+platform\./iu);
    expect(packageJson.scripts["fixture:model-gateway-credit-runtime"]).toBe(
      "tsx test/fixtures/model-gateway-credit-runtime.ts",
    );
    expect(packageJson.scripts).not.toHaveProperty("fixture:model-gateway-litellm-credit-runtime");
  });

  it("uses fixed debug stages without dynamic startup data", () => {
    for (const stage of [
      "configuration-valid",
      "trust-ready",
      "composition-ready",
      "runtime-starting",
      "runtime-ready",
    ]) {
      expect(fixtureSource).toContain(`debugStage(environment, "${stage}")`);
    }
    expect(fixtureSource).not.toMatch(/debugStage\(environment,\s*`/u);
  });

  it.each(["litellm.config.example.yaml", "litellm.config.dev.yaml"])(
    "%s does not silently drop unsupported request parameters",
    (name) => {
      const settings = liteLlmConfig(name).litellm_settings;
      expect(settings).toBeTypeOf("object");
      expect(settings).not.toBeNull();
      expect(settings).not.toHaveProperty("drop_params");
    },
  );
});
