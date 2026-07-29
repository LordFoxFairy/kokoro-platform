import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { SiteDeploymentProviderRegistry } from "../../application/contracts/site-deployment-provider.js";
import { SiteProviderRpcAdapter } from "./site-provider-rpc.js";

export async function loadSiteProviderRegistry(path: string): Promise<SiteDeploymentProviderRegistry> {
  const root = record(JSON.parse(await readFile(path, 64 * 1024, false)) as unknown,
    "SITE_PROVIDER_REGISTRY_INVALID");
  exact(root, ["version", "providers"], "SITE_PROVIDER_REGISTRY_INVALID");
  if (root.version !== 1 || !Array.isArray(root.providers) || root.providers.length < 1 ||
      root.providers.length > 32) throw new Error("SITE_PROVIDER_REGISTRY_INVALID");
  const providers = await Promise.all(root.providers.map(async (item) => {
    const value = record(item, "SITE_PROVIDER_REGISTRY_INVALID");
    exact(value, ["namespace", "endpoint", "tokenFile", "timeoutMs"], "SITE_PROVIDER_REGISTRY_INVALID");
    if (typeof value.namespace !== "string" || typeof value.endpoint !== "string" ||
        typeof value.tokenFile !== "string" || !isAbsolute(value.tokenFile) ||
        typeof value.timeoutMs !== "number") throw new Error("SITE_PROVIDER_REGISTRY_INVALID");
    const bearerToken = (await readFile(value.tokenFile, 4096, true)).trim();
    return new SiteProviderRpcAdapter({ namespace: value.namespace, endpoint: value.endpoint,
      bearerToken, timeoutMs: value.timeoutMs });
  }));
  return new SiteDeploymentProviderRegistry(providers);
}

async function readFile(path: string, maximum: number, privateFile: boolean): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > maximum) {
      throw new Error(privateFile ? "SITE_PROVIDER_TOKEN_FILE_INVALID" : "SITE_PROVIDER_REGISTRY_INVALID");
    }
    if (privateFile && (stat.mode & 0o077) !== 0) {
      throw new Error("SITE_PROVIDER_TOKEN_FILE_PERMISSIONS_INVALID");
    }
    const buffer = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(buffer, 0, stat.size, 0);
    if (bytesRead !== stat.size) throw new Error("SITE_PROVIDER_FILE_SHORT_READ");
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } finally {
    await handle.close();
  }
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[], code: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error(code);
}
