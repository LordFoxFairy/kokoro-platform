import { createHash } from "node:crypto";
import { isIP } from "node:net";
import {
  SiteProviderEffectError,
  type SiteDeploymentProvider,
  type SitePromotionCommand,
  type SitePromotionObservation,
  type SiteTrafficStopCommand,
  type SiteTrafficStopProviderObservation,
} from "../../application/contracts/site-deployment-provider.js";

export { SiteProviderEffectError };

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class SiteProviderRpcAdapter implements SiteDeploymentProvider {
  readonly namespace: string;
  readonly #endpoint: string;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #fetch: Fetch;

  constructor(input: Readonly<{ namespace: string; endpoint: string; bearerToken: string;
    timeoutMs: number; fetch?: Fetch }>) {
    if (!/^[a-z][a-z0-9.-]{1,63}$/u.test(input.namespace)) {
      throw new Error("SITE_PROVIDER_NAMESPACE_INVALID");
    }
    const endpoint = providerEndpoint(input.endpoint);
    if (input.bearerToken.length < 8 || input.bearerToken.length > 4096 || /[\r\n]/u.test(input.bearerToken)) {
      throw new Error("SITE_PROVIDER_RPC_TOKEN_INVALID");
    }
    if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > 30_000) {
      throw new Error("SITE_PROVIDER_RPC_TIMEOUT_INVALID");
    }
    this.namespace = input.namespace;
    this.#endpoint = endpoint;
    this.#token = input.bearerToken;
    this.#timeoutMs = input.timeoutMs;
    this.#fetch = input.fetch ?? globalThis.fetch;
  }

  promote(command: SitePromotionCommand, signal: AbortSignal): Promise<SitePromotionObservation> {
    return this.callPromotion("promote", command, signal);
  }

  observePromotion(command: SitePromotionCommand, signal: AbortSignal): Promise<SitePromotionObservation> {
    return this.callPromotion("observe-promotion", command, signal);
  }

  stopTraffic(
    command: SiteTrafficStopCommand,
    signal: AbortSignal,
  ): Promise<SiteTrafficStopProviderObservation> {
    return this.callTraffic("stop-traffic", command, signal);
  }

  observeTrafficStop(
    command: SiteTrafficStopCommand,
    signal: AbortSignal,
  ): Promise<SiteTrafficStopProviderObservation> {
    return this.callTraffic("observe-traffic-stop", command, signal);
  }

  private async callPromotion(
    method: "promote" | "observe-promotion",
    command: SitePromotionCommand,
    signal: AbortSignal,
  ): Promise<SitePromotionObservation> {
    const response = await this.call(method, command, signal);
    const value = record(response.value);
    exact(value, ["status", "deploymentRef", "observedAt"]);
    if (!includes(["ready", "pending", "unknown", "rejected"] as const, value.status) ||
        (value.deploymentRef !== null && typeof value.deploymentRef !== "string") ||
        typeof value.observedAt !== "string" || !Number.isFinite(Date.parse(value.observedAt))) {
      throw new SiteProviderEffectError("unknown", "PROVIDER_RPC_RESPONSE_INVALID");
    }
    if ((value.status === "ready" || value.status === "pending") && value.deploymentRef === null) {
      throw new SiteProviderEffectError("unknown", "PROVIDER_RPC_RESPONSE_INVALID");
    }
    return Object.freeze({
      status: value.status,
      deploymentRef: value.deploymentRef,
      observedAt: value.observedAt,
      payloadDigest: response.payloadDigest,
    });
  }

  private async callTraffic(
    method: "stop-traffic" | "observe-traffic-stop",
    command: SiteTrafficStopCommand,
    signal: AbortSignal,
  ): Promise<SiteTrafficStopProviderObservation> {
    const response = await this.call(method, command, signal);
    const value = record(response.value);
    exact(value, ["status", "observedAt"]);
    if (!includes(["stopped", "serving", "unknown", "rejected"] as const, value.status) ||
        typeof value.observedAt !== "string" || !Number.isFinite(Date.parse(value.observedAt))) {
      throw new SiteProviderEffectError("unknown", "PROVIDER_RPC_RESPONSE_INVALID");
    }
    return Object.freeze({
      status: value.status,
      observedAt: value.observedAt,
      payloadDigest: response.payloadDigest,
    });
  }

  private async call(
    method: string,
    command: SitePromotionCommand | SiteTrafficStopCommand,
    signal: AbortSignal,
  ): Promise<Readonly<{ value: unknown; payloadDigest: string }>> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error("PROVIDER_RPC_TIMEOUT")), this.#timeoutMs);
    timer.unref();
    try {
      const response = await this.#fetch(`${this.#endpoint}/v1/site-runtime/${method}`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.any([signal, timeout.signal]),
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.#token}`,
          "content-type": "application/json",
          "idempotency-key": command.operationKey,
        },
        body: JSON.stringify(command),
      });
      if (!response.ok) {
        throw new SiteProviderEffectError(
          response.status >= 500 || response.status === 408 || response.status === 429 ? "unknown" : "failed",
          response.status >= 500 || response.status === 408 || response.status === 429
            ? "PROVIDER_RPC_UNAVAILABLE" : "PROVIDER_RPC_REJECTED",
        );
      }
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (contentType !== "application/json") {
        throw new SiteProviderEffectError("unknown", "PROVIDER_RPC_RESPONSE_INVALID");
      }
      const bytes = await readBounded(response, 256 * 1024);
      let value: unknown;
      try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
      catch { throw new SiteProviderEffectError("unknown", "PROVIDER_RPC_RESPONSE_INVALID"); }
      return Object.freeze({ value, payloadDigest: createHash("sha256").update(bytes).digest("hex") });
    } catch (error) {
      if (error instanceof SiteProviderEffectError || signal.aborted) throw error;
      throw new SiteProviderEffectError("unknown",
        timeout.signal.aborted ? "PROVIDER_RPC_TIMEOUT" : "PROVIDER_RPC_UNAVAILABLE");
    } finally {
      clearTimeout(timer);
    }
  }
}

function providerEndpoint(raw: string): string {
  let endpoint: URL;
  try { endpoint = new URL(raw); } catch { throw new Error("SITE_PROVIDER_RPC_ENDPOINT_INVALID"); }
  if (endpoint.protocol !== "https:" || endpoint.username !== "" || endpoint.password !== "" ||
      endpoint.search !== "" || endpoint.hash !== "" || endpoint.port !== "" ||
      isIP(endpoint.hostname) !== 0 || endpoint.hostname === "localhost" ||
      endpoint.pathname.includes("..")) {
    throw new Error("SITE_PROVIDER_RPC_ENDPOINT_INVALID");
  }
  return endpoint.href.replace(/\/$/u, "");
}

async function readBounded(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > maximum)) {
    throw new SiteProviderEffectError("unknown", "PROVIDER_RPC_RESPONSE_TOO_LARGE");
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximum) throw new SiteProviderEffectError("unknown", "PROVIDER_RPC_RESPONSE_TOO_LARGE");
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SiteProviderEffectError("unknown", "PROVIDER_RPC_RESPONSE_INVALID");
  }
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw new SiteProviderEffectError("unknown", "PROVIDER_RPC_RESPONSE_INVALID");
  }
}
function includes<const Values extends readonly string[]>(values: Values, value: unknown): value is Values[number] {
  return typeof value === "string" && values.includes(value);
}
