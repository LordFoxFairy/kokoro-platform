import { createHash } from "node:crypto";
import { isIP } from "node:net";
import {
  SiteProviderEffectError,
  sitePromotionCommandDigest,
  type SiteDeploymentProvider,
  type SitePromotionCommand,
  type SitePromotionObservation,
  type SiteTrafficStopCommand,
  type SiteTrafficStopProviderObservation,
} from "../../application/contracts/site-deployment-provider.js";

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const SHA256 = /^[a-f0-9]{64}$/u;

export class FixedSiteHttpDeploymentProvider implements SiteDeploymentProvider {
  readonly namespace: string;
  readonly #metadataEndpoint: string;
  readonly #timeoutMs: number;
  readonly #fetch: Fetch;

  constructor(input: Readonly<{ namespace: string; metadataEndpoint: string; timeoutMs: number; fetch?: Fetch }>) {
    if (!/^[a-z][a-z0-9.-]{1,63}$/u.test(input.namespace)) throw new Error("SITE_PROVIDER_NAMESPACE_INVALID");
    if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > 30_000) {
      throw new Error("FIXED_SITE_METADATA_TIMEOUT_INVALID");
    }
    this.namespace = input.namespace;
    this.#metadataEndpoint = metadataEndpoint(input.metadataEndpoint);
    this.#timeoutMs = input.timeoutMs;
    this.#fetch = input.fetch ?? globalThis.fetch;
  }

  promote(command: SitePromotionCommand, signal: AbortSignal): Promise<SitePromotionObservation> {
    return this.observe(command, signal);
  }

  observePromotion(command: SitePromotionCommand, signal: AbortSignal): Promise<SitePromotionObservation> {
    return this.observe(command, signal);
  }

  async stopTraffic(
    _command: SiteTrafficStopCommand,
    _signal: AbortSignal,
  ): Promise<SiteTrafficStopProviderObservation> {
    throw new SiteProviderEffectError("failed", "FIXED_SITE_TRAFFIC_CONTROL_UNSUPPORTED");
  }

  async observeTrafficStop(
    _command: SiteTrafficStopCommand,
    _signal: AbortSignal,
  ): Promise<SiteTrafficStopProviderObservation> {
    throw new SiteProviderEffectError("failed", "FIXED_SITE_TRAFFIC_CONTROL_UNSUPPORTED");
  }

  private async observe(command: SitePromotionCommand, signal: AbortSignal): Promise<SitePromotionObservation> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.#timeoutMs);
    timer.unref();
    try {
      const response = await this.#fetch(this.#metadataEndpoint, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.any([signal, timeout.signal]),
        headers: { accept: "application/json", "cache-control": "no-store" },
      });
      if (!response.ok) {
        throw new SiteProviderEffectError(response.status >= 500 ? "unknown" : "failed",
          response.status >= 500 ? "FIXED_SITE_METADATA_UNAVAILABLE" : "FIXED_SITE_METADATA_REJECTED");
      }
      if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        throw new SiteProviderEffectError("unknown", "FIXED_SITE_METADATA_INVALID");
      }
      const bytes = await readBounded(response, 64 * 1024);
      let raw: unknown;
      try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
      catch { throw new SiteProviderEffectError("unknown", "FIXED_SITE_METADATA_INVALID"); }
      const value = metadata(raw);
      if (value.siteId !== command.siteRef || value.siteReleaseRef !== command.releaseRef ||
          value.webArtifactDigest !== command.webArtifactDigest) {
        throw new SiteProviderEffectError("unknown", "FIXED_SITE_METADATA_BINDING_MISMATCH");
      }
      return Object.freeze({
        status: value.readiness === "ready" ? "ready" : "pending",
        deploymentRef: value.deploymentRef,
        observedAt: value.observedAt,
        operationKey: command.operationKey,
        siteRef: command.siteRef,
        providerProjectRef: command.providerProjectRef,
        releaseRef: command.releaseRef,
        webArtifactDigest: command.webArtifactDigest,
        releaseManifestDigest: command.releaseManifestDigest,
        certificationDigest: command.certificationDigest,
        environment: command.environment,
        region: command.region,
        audience: command.audience,
        sessionContractRevision: command.sessionContractRevision,
        commandDigest: sitePromotionCommandDigest(command),
        payloadDigest: createHash("sha256").update(bytes).digest("hex"),
      });
    } catch (error) {
      if (error instanceof SiteProviderEffectError) throw error;
      if (signal.aborted) throw new SiteProviderEffectError("unknown", "FIXED_SITE_METADATA_ABORTED");
      throw new SiteProviderEffectError("unknown",
        timeout.signal.aborted ? "FIXED_SITE_METADATA_TIMEOUT" : "FIXED_SITE_METADATA_UNAVAILABLE");
    } finally {
      clearTimeout(timer);
    }
  }
}

function metadata(input: unknown): Readonly<{ schemaVersion: 1; siteId: string; siteReleaseRef: string;
  webArtifactDigest: string; deploymentRef: string; readiness: "ready" | "not_ready"; observedAt: string }> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new SiteProviderEffectError("unknown", "FIXED_SITE_METADATA_INVALID");
  }
  const value = input as Record<string, unknown>;
  const keys = ["schemaVersion", "siteId", "siteReleaseRef", "webArtifactDigest", "deploymentRef",
    "readiness", "observedAt"];
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)) ||
      value.schemaVersion !== 1 || typeof value.siteId !== "string" || typeof value.siteReleaseRef !== "string" ||
      typeof value.webArtifactDigest !== "string" || !SHA256.test(value.webArtifactDigest) ||
      typeof value.deploymentRef !== "string" || value.deploymentRef.length < 3 || value.deploymentRef.length > 256 ||
      !["ready", "not_ready"].includes(String(value.readiness)) ||
      typeof value.observedAt !== "string" || !Number.isFinite(Date.parse(value.observedAt))) {
    throw new SiteProviderEffectError("unknown", "FIXED_SITE_METADATA_INVALID");
  }
  return value as ReturnType<typeof metadata>;
}

function metadataEndpoint(raw: string): string {
  let value: URL;
  try { value = new URL(raw); } catch { throw new Error("FIXED_SITE_METADATA_ENDPOINT_INVALID"); }
  const loopback = value.hostname === "127.0.0.1" || value.hostname === "[::1]";
  if ((value.protocol !== "https:" && !(value.protocol === "http:" && (loopback || value.hostname.endsWith(".internal")))) ||
      value.username !== "" || value.password !== "" || value.search !== "" || value.hash !== "" ||
      value.pathname.includes("..") || value.pathname === "/" ||
      (isIP(value.hostname) !== 0 && !loopback)) throw new Error("FIXED_SITE_METADATA_ENDPOINT_INVALID");
  return value.href;
}

async function readBounded(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > maximum)) {
    throw new SiteProviderEffectError("unknown", "FIXED_SITE_METADATA_INVALID");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength < 2 || bytes.byteLength > maximum) {
    throw new SiteProviderEffectError("unknown", "FIXED_SITE_METADATA_INVALID");
  }
  return bytes;
}
