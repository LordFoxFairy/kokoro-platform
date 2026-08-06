import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  createHubFixturePublicationResult,
  createHubFixtureSetupResult,
  emptyCapabilityCatalogRef,
  parseHubFixtureCommand,
  setupHubFixture,
} from "../fixtures/web-chat-credit-runtime.js";

const source = readFileSync(new URL("../fixtures/web-chat-credit-runtime.ts", import.meta.url), "utf8");

describe("Hub-owned Web Chat Credit runtime fixture", () => {
  it("accepts only setup and publish commands", () => {
    expect(parseHubFixtureCommand(["setup"])).toBe("setup");
    expect(parseHubFixtureCommand(["publish"])).toBe("publish");
    expect(() => parseHubFixtureCommand([])).toThrow("HUB_FIXTURE_COMMAND_INVALID");
    expect(() => parseHubFixtureCommand(["observe"])).toThrow("HUB_FIXTURE_COMMAND_INVALID");
  });

  it("returns only bounded Hub runtime references and private paths", () => {
    const result = createHubFixtureSetupResult({
      baseUrl: "https://127.0.0.1:4252/",
      healthUrl: "http://127.0.0.1:4253/",
      serverName: "127.0.0.1",
      trustRoot: "/private/hub",
      certificateAuthorityFile: "/private/hub/ca.pem",
      serverCertificateFile: "/private/hub/server.pem",
      serverPrivateKeyFile: "/private/hub/server-key.pem",
      agentCertificateFile: "/private/hub/agent.pem",
      agentPrivateKeyFile: "/private/hub/agent-key.pem",
      platformCertificateFile: "/private/hub/platform.pem",
      platformPrivateKeyFile: "/private/hub/platform-key.pem",
      peerRegistryFile: "/private/hub/peers.json",
      workspaceConfigFile: "/private/hub/workspace.yaml",
      artifactCacheDirectory: "/private/hub/agent-cache",
    });
    expect(result.kind).toBe("hub-web-chat-credit-runtime-setup");
    expect(Object.keys(result)).not.toContain("secret");
    expect(() => createHubFixtureSetupResult({ ...result, baseUrl: "http://127.0.0.1:4252/" }))
      .toThrow("HUB_FIXTURE_SETUP_RESULT_INVALID");
    expect(() => createHubFixtureSetupResult({
      ...result,
      serverName: "hub-runtime.fixture.local" as "127.0.0.1",
    })).toThrow("HUB_FIXTURE_SETUP_RESULT_INVALID");
  });

  it("generates a complete Hub CA, server, and client trust chain", async () => {
    const privateDirectory = mkdtempSync(join(tmpdir(), "kokoro-hub-runtime-fixture-"));
    try {
      await expect(setupHubFixture({
        KOKORO_HUB_FIXTURE_PRIVATE_DIR: privateDirectory,
        KOKORO_HUB_FIXTURE_CONNECT_PORT: "4252",
        KOKORO_HUB_FIXTURE_HEALTH_PORT: "4253",
      })).resolves.toMatchObject({
        baseUrl: "https://127.0.0.1:4252/",
        healthUrl: "http://127.0.0.1:4253/",
        serverName: "127.0.0.1",
      });
    } finally {
      rmSync(privateDirectory, { recursive: true, force: true });
    }
  });

  it("binds the same deterministic empty catalog as Platform", () => {
    expect(emptyCapabilityCatalogRef()).toBe(
      "agent-catalog:sha256:69fe5250b0243b28a4cddca8a7d8d40fadbb998f7ebaccccccc629c3e89412c8",
    );
    expect(createHubFixturePublicationResult({
      agentCatalogRef: emptyCapabilityCatalogRef(),
      projectionCommitted: true,
      replayed: false,
    })).toEqual({
      schemaVersion: 1,
      kind: "hub-web-chat-credit-runtime-publication",
      agentCatalogRef: emptyCapabilityCatalogRef(),
      projectionCommitted: true,
      replayed: false,
    });
  });

  it("publishes through the production Hub contract without child database access", () => {
    expect(source).toContain("HubCatalogService");
    expect(source).toContain("freezeCatalogRequestDigest");
    expect(source).not.toMatch(/MongoClient|pg|DATABASE_URL|INSERT\s+INTO|UPDATE\s+/u);
  });
});
