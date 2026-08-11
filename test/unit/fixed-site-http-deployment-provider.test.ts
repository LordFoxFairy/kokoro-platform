import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FixedSiteHttpDeploymentProvider } from
  "../../src/modules/site/infrastructure/http/fixed-site-http-deployment-provider.js";
import { loadSiteProviderRegistry } from
  "../../src/modules/site/infrastructure/rpc/site-provider-registry-config.js";
import { sitePromotionCommandDigest } from
  "../../src/modules/site/application/contracts/site-deployment-provider.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) =>
  new Promise<void>((resolve) => server.close(() => resolve())))));

const command = Object.freeze({ operationKey: "operation:core:1", siteRef: "site:core",
  providerProjectRef: "core-site", releaseRef: "site-release:core:1",
  webArtifactDigest: "a".repeat(64), releaseManifestDigest: "b".repeat(64),
  certificationDigest: "c".repeat(64), environment: "production" as const,
  region: "us-east-1", audience: "site-product", sessionContractRevision: "session-browser-v3" });

function metadata(change: Record<string, unknown> = {}) {
  return { schemaVersion: 1, siteId: command.siteRef, siteReleaseRef: command.releaseRef,
    webArtifactDigest: command.webArtifactDigest, deploymentRef: "deployment:core:1",
    readiness: "ready", observedAt: "2026-08-11T00:00:00.000Z", ...change };
}

async function fixture(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture address");
  return `http://127.0.0.1:${address.port}/.well-known/kokoro-release`;
}

describe("FixedSiteHttpDeploymentProvider", () => {
  it("maps one exact fixed-Site metadata observation to the existing provider contract", async () => {
    let count = 0;
    const endpoint = await fixture((_request, response) => {
      count += 1; response.setHeader("content-type", "application/json"); response.end(JSON.stringify(metadata()));
    });
    const provider = new FixedSiteHttpDeploymentProvider({ namespace: "core.fixed", metadataEndpoint: endpoint,
      timeoutMs: 1000 });
    const first = await provider.promote(command, new AbortController().signal);
    const replay = await provider.observePromotion(command, new AbortController().signal);
    expect(first).toEqual(replay);
    expect(first).toMatchObject({ status: "ready", deploymentRef: "deployment:core:1",
      operationKey: command.operationKey, commandDigest: sitePromotionCommandDigest(command) });
    expect(count).toBe(2);
  });

  it.each<readonly [string, Record<string, unknown>]>([
    ["siteId", { siteId: "site:other" }],
    ["siteReleaseRef", { siteReleaseRef: "release:other" }],
    ["webArtifactDigest", { webArtifactDigest: "d".repeat(64) }],
    ["extra field", { extra: true }],
  ])("rejects mismatched or malformed %s metadata", async (_name, change) => {
    const endpoint = await fixture((_request, response) => {
      response.setHeader("content-type", "application/json"); response.end(JSON.stringify(metadata(change)));
    });
    const provider = new FixedSiteHttpDeploymentProvider({ namespace: "core.fixed", metadataEndpoint: endpoint,
      timeoutMs: 1000 });
    await expect(provider.promote(command, new AbortController().signal))
      .rejects.toMatchObject({ code: Object.hasOwn(change, "extra") ? "FIXED_SITE_METADATA_INVALID" : "FIXED_SITE_METADATA_BINDING_MISMATCH" });
  });

  it("rejects non-2xx, redirects and malformed JSON", async () => {
    for (const responseCase of [{ status: 503, body: "{}" }, { status: 302, body: "" }, { status: 200, body: "{" }]) {
      const endpoint = await fixture((_request, response) => {
        response.statusCode = responseCase.status;
        if (responseCase.status === 302) response.setHeader("location", endpoint);
        response.setHeader("content-type", "application/json"); response.end(responseCase.body);
      });
      const provider = new FixedSiteHttpDeploymentProvider({ namespace: "core.fixed", metadataEndpoint: endpoint,
        timeoutMs: 1000 });
      await expect(provider.promote(command, new AbortController().signal)).rejects.toBeTruthy();
    }
  });

  it("honors caller abort and bounded timeout", async () => {
    const endpoint = await fixture(() => undefined);
    const timeoutProvider = new FixedSiteHttpDeploymentProvider({ namespace: "core.fixed",
      metadataEndpoint: endpoint, timeoutMs: 100 });
    await expect(timeoutProvider.promote(command, new AbortController().signal))
      .rejects.toMatchObject({ code: "FIXED_SITE_METADATA_TIMEOUT" });
    const caller = new AbortController(); caller.abort();
    await expect(timeoutProvider.promote(command, caller.signal)).rejects.toBeTruthy();
  });

  it("parses tagged fixed_http providers while preserving the untagged RPC document", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kokoro-fixed-site-registry-"));
    const fixed = join(directory, "fixed.json");
    await writeFile(fixed, JSON.stringify({ version: 1, providers: [{ kind: "fixed_http",
      namespace: "core.fixed", metadataEndpoint: "http://127.0.0.1:3000/.well-known/kokoro-release",
      timeoutMs: 1000 }] }));
    expect((await loadSiteProviderRegistry(fixed)).require("core.fixed"))
      .toBeInstanceOf(FixedSiteHttpDeploymentProvider);
    const unknown = join(directory, "unknown.json");
    await writeFile(unknown, JSON.stringify({ version: 1, providers: [{ kind: "other",
      namespace: "core.fixed", metadataEndpoint: "http://127.0.0.1:3000", timeoutMs: 1000 }] }));
    await expect(loadSiteProviderRegistry(unknown)).rejects.toThrow("SITE_PROVIDER_REGISTRY_INVALID");
  });
});
