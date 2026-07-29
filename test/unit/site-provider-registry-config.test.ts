import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSiteProviderRegistry } from "../../src/modules/site/infrastructure/rpc/site-provider-registry-config.js";

describe("Site provider production registry", () => {
  it("loads explicit namespaces from private token files and has no fallback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kokoro-site-provider-"));
    const tokenFile = join(directory, "token");
    const registryFile = join(directory, "registry.json");
    await writeFile(tokenFile, "provider-secret-token\n", { mode: 0o600 });
    await writeFile(registryFile, JSON.stringify({ version: 1, providers: [{ namespace: "vercel",
      endpoint: "https://deploy.internal.example", tokenFile, timeoutMs: 2_000 }] }), { mode: 0o600 });
    const registry = await loadSiteProviderRegistry(registryFile);
    expect(registry.require("vercel").namespace).toBe("vercel");
    expect(() => registry.require("cloudflare")).toThrow("SITE_PROVIDER_NOT_CONFIGURED:cloudflare");
  });

  it("rejects token files readable by other principals", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kokoro-site-provider-"));
    const tokenFile = join(directory, "token");
    const registryFile = join(directory, "registry.json");
    await writeFile(tokenFile, "provider-secret-token\n", { mode: 0o644 });
    await writeFile(registryFile, JSON.stringify({ version: 1, providers: [{ namespace: "vercel",
      endpoint: "https://deploy.internal.example", tokenFile, timeoutMs: 2_000 }] }), { mode: 0o600 });
    await expect(loadSiteProviderRegistry(registryFile)).rejects.toThrow("SITE_PROVIDER_TOKEN_FILE_PERMISSIONS_INVALID");
  });
});
