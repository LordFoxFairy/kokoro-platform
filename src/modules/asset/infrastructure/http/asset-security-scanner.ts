import { createHash } from "node:crypto";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import type { AssetSecurityScannerPort } from
  "../../application/contracts/asset-scan-worker-ports.js";
import type { AssetScanObservation } from "../../domain/scan-evaluation.js";

const MAXIMUM_RESPONSE_BYTES = 256 * 1024;

type ScannerInput = Parameters<AssetSecurityScannerPort["inspect"]>[0];
type ScannerTransport = (input: Readonly<{
  url: URL;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
  signal: AbortSignal;
  tls: Readonly<{ ca: string; cert: string; key: string }>;
}>) => Promise<Readonly<{ status: number; contentType: string | undefined; body: Uint8Array }>>;

export class AssetScannerError extends Error {
  constructor(readonly code: string, readonly retryable: boolean, options?: ErrorOptions) {
    super(code, options);
  }
}

export class HttpsAssetSecurityScanner implements AssetSecurityScannerPort {
  readonly #endpoint: URL;
  readonly #audience: string;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #tls: Readonly<{ ca: string; cert: string; key: string }>;
  readonly #transport: ScannerTransport;

  constructor(input: Readonly<{
    endpoint: string;
    audience: string;
    bearerToken: string;
    timeoutMs: number;
    tls: Readonly<{ ca: string; cert: string; key: string }>;
    transport?: ScannerTransport;
  }>) {
    this.#endpoint = scannerEndpoint(input.endpoint);
    this.#audience = bounded(input.audience, 3, 256, "ASSET_SCANNER_AUDIENCE_INVALID");
    this.#token = secret(input.bearerToken, "ASSET_SCANNER_TOKEN_INVALID");
    if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > 60_000) {
      throw new Error("ASSET_SCANNER_TIMEOUT_INVALID");
    }
    if (!input.tls.ca.includes("BEGIN CERTIFICATE") || !input.tls.cert.includes("BEGIN CERTIFICATE") ||
        !input.tls.key.includes("BEGIN PRIVATE KEY")) throw new Error("ASSET_SCANNER_TLS_INVALID");
    this.#timeoutMs = input.timeoutMs;
    this.#tls = Object.freeze({ ...input.tls });
    this.#transport = input.transport ?? nodeHttpsTransport;
  }

  async inspect(input: ScannerInput): Promise<AssetScanObservation> {
    const command = scanCommand(input);
    const commandDigest = assetScanCommandDigest(input);
    const body = new TextEncoder().encode(JSON.stringify({ ...command, commandDigest }));
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error("ASSET_SCANNER_TIMEOUT")), this.#timeoutMs);
    timer.unref();
    let response: Awaited<ReturnType<ScannerTransport>>;
    try {
      response = await this.#transport({
        url: this.#endpoint,
        headers: Object.freeze({ accept: "application/json", authorization: `Bearer ${this.#token}`,
          "content-type": "application/json", "content-length": String(body.byteLength),
          "idempotency-key": commandDigest, "x-kokoro-audience": this.#audience }),
        body, signal: timeout.signal, tls: this.#tls,
      });
    } catch (error) {
      if (error instanceof AssetScannerError) throw error;
      throw new AssetScannerError(timeout.signal.aborted ? "ASSET_SCANNER_TIMEOUT" : "ASSET_SCANNER_UNAVAILABLE",
        true, { cause: error });
    } finally {
      clearTimeout(timer);
    }
    if (response.status < 200 || response.status >= 300) {
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      throw new AssetScannerError(retryable ? "ASSET_SCANNER_UNAVAILABLE" : "ASSET_SCANNER_REJECTED", retryable);
    }
    if (response.contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      throw new AssetScannerError("ASSET_SCANNER_RESPONSE_INVALID", true);
    }
    if (response.body.byteLength > MAXIMUM_RESPONSE_BYTES) {
      throw new AssetScannerError("ASSET_SCANNER_RESPONSE_TOO_LARGE", true);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body)) as unknown; }
    catch { throw new AssetScannerError("ASSET_SCANNER_RESPONSE_INVALID", true); }
    const value = record(parsed);
    exact(value, ["commandDigest", "storageTenantRef", "storageRegion", "quarantineObjectRef",
      "providerVersionRef", "expectedChecksumSha256", "scannerDefinitionRef", "scannerRevisionRef",
      "signatureRevisionRef", "detectedMediaType", "magicSignatureRef", "containerSummaryDigest",
      "malwareDisposition", "contentSafetyDisposition", "evidenceRef", "evidenceDigest", "occurredAt"]);
    if (value.commandDigest !== commandDigest || value.storageTenantRef !== input.storageTenantRef ||
        value.storageRegion !== input.storageRegion || value.quarantineObjectRef !== input.quarantineObjectRef ||
        value.providerVersionRef !== input.providerVersionRef ||
        value.expectedChecksumSha256 !== input.expectedChecksumSha256 ||
        value.scannerDefinitionRef !== input.policy.scannerDefinitionRef ||
        value.scannerRevisionRef !== input.policy.scannerRevisionRef ||
        value.signatureRevisionRef !== input.policy.signatureRevisionRef) {
      throw new AssetScannerError("ASSET_SCANNER_RESPONSE_BINDING_MISMATCH", true);
    }
    const observation = scannerObservation(value);
    return Object.freeze(observation);
  }
}

export function assetScanCommandDigest(input: ScannerInput): string {
  const command = scanCommand(input);
  return createHash("sha256").update("kokoro-asset-scan-command-v1\0", "utf8")
    .update(JSON.stringify(Object.values(command)), "utf8").digest("hex");
}

function scanCommand(input: ScannerInput) {
  return Object.freeze({ storageTenantRef: identifier(input.storageTenantRef),
    storageRegion: identifier(input.storageRegion), quarantineObjectRef: objectRef(input.quarantineObjectRef),
    providerVersionRef: bounded(input.providerVersionRef, 1, 2_048, "ASSET_SCANNER_COMMAND_INVALID"),
    expectedChecksumSha256: digest(input.expectedChecksumSha256), maximumBytes: positiveBigint(input.maximumBytes),
    policyRevisionRef: identifier(input.policy.policyRevisionRef), purpose: bounded(input.policy.purpose, 1, 128,
      "ASSET_SCANNER_COMMAND_INVALID"), scannerDefinitionRef: identifier(input.policy.scannerDefinitionRef),
    scannerRevisionRef: identifier(input.policy.scannerRevisionRef),
    signatureRevisionRef: identifier(input.policy.signatureRevisionRef),
    contentSafetyRequired: input.policy.contentSafetyRequired });
}

async function nodeHttpsTransport(input: Parameters<ScannerTransport>[0]): Promise<Awaited<ReturnType<ScannerTransport>>> {
  return new Promise((resolve, reject) => {
    const options: RequestOptions = { protocol: "https:", hostname: input.url.hostname, port: 443,
      path: input.url.pathname, method: "POST", headers: input.headers, ca: input.tls.ca,
      cert: input.tls.cert, key: input.tls.key, minVersion: "TLSv1.3", rejectUnauthorized: true,
      servername: input.url.hostname, signal: input.signal };
    const request = httpsRequest(options, (response) => {
      const chunks: Buffer[] = [];
      let length = 0;
      const declared = response.headers["content-length"];
      if (declared !== undefined && (!/^(?:0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > MAXIMUM_RESPONSE_BYTES)) {
        response.destroy(); reject(new AssetScannerError("ASSET_SCANNER_RESPONSE_TOO_LARGE", true)); return;
      }
      response.on("data", (chunk: Buffer | Uint8Array) => {
        const bytes = Buffer.from(chunk); length += bytes.byteLength;
        if (length > MAXIMUM_RESPONSE_BYTES) {
          response.destroy(new AssetScannerError("ASSET_SCANNER_RESPONSE_TOO_LARGE", true)); return;
        }
        chunks.push(bytes);
      });
      response.once("error", reject);
      response.once("end", () => resolve(Object.freeze({ status: response.statusCode ?? 0,
        contentType: Array.isArray(response.headers["content-type"])
          ? response.headers["content-type"][0] : response.headers["content-type"],
        body: new Uint8Array(Buffer.concat(chunks, length)) })));
    });
    request.once("error", reject);
    request.end(input.body);
  });
}

function scannerObservation(value: Record<string, unknown>): AssetScanObservation {
  const malware = value.malwareDisposition;
  const safety = value.contentSafetyDisposition;
  if (!(["clean", "detected", "unavailable"] as const).includes(malware as never) ||
      !(["allow", "deny", "not_required", "unavailable"] as const).includes(safety as never) ||
      typeof value.occurredAt !== "string" || !Number.isFinite(Date.parse(value.occurredAt))) invalidResponse();
  return { scannerDefinitionRef: identifierResponse(value.scannerDefinitionRef),
    scannerRevisionRef: identifierResponse(value.scannerRevisionRef),
    signatureRevisionRef: identifierResponse(value.signatureRevisionRef),
    detectedMediaType: mediaTypeResponse(value.detectedMediaType),
    magicSignatureRef: identifierResponse(value.magicSignatureRef),
    containerSummaryDigest: digestResponse(value.containerSummaryDigest),
    malwareDisposition: malware as AssetScanObservation["malwareDisposition"],
    contentSafetyDisposition: safety as AssetScanObservation["contentSafetyDisposition"],
    evidenceRef: identifierResponse(value.evidenceRef), evidenceDigest: digestResponse(value.evidenceDigest),
    occurredAt: value.occurredAt };
}

function scannerEndpoint(raw: string): URL {
  let value: URL;
  try { value = new URL(raw); } catch { throw new Error("ASSET_SCANNER_ENDPOINT_INVALID"); }
  if (value.protocol !== "https:" || value.username !== "" || value.password !== "" || value.port !== "" ||
      value.search !== "" || value.hash !== "" || isIP(value.hostname) !== 0 ||
      value.hostname.toLowerCase() === "localhost" || value.pathname !== "/v1/assets/inspect") {
    throw new Error("ASSET_SCANNER_ENDPOINT_INVALID");
  }
  return value;
}

function secret(value: string, code: string): string {
  const result = value.trim();
  if (result.length < 16 || result.length > 4_096 || /[\r\n]/u.test(result)) throw new Error(code);
  return result;
}
function identifier(value: string): string { return boundedPattern(value, /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u); }
function objectRef(value: string): string { return boundedPattern(value, /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,1023}$/u); }
function boundedPattern(value: string, pattern: RegExp): string {
  if (!pattern.test(value)) throw new Error("ASSET_SCANNER_COMMAND_INVALID"); return value;
}
function bounded(value: string, min: number, max: number, code: string): string {
  if (typeof value !== "string" || value.length < min || value.length > max || hasControlCharacter(value)) {
    throw new Error(code);
  } return value;
}
function digest(value: string): string { return boundedPattern(value, /^[a-f0-9]{64}$/u); }
function positiveBigint(value: bigint): string {
  if (typeof value !== "bigint" || value < 1n || value > 9_223_372_036_854_775_807n) {
    throw new Error("ASSET_SCANNER_COMMAND_INVALID");
  } return value.toString();
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalidResponse();
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) invalidResponse();
}
function identifierResponse(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(value)) invalidResponse();
  return value;
}
function digestResponse(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) invalidResponse(); return value;
}
function mediaTypeResponse(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/u.test(value)) invalidResponse();
  return value;
}
function invalidResponse(): never { throw new AssetScannerError("ASSET_SCANNER_RESPONSE_INVALID", true); }

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point < 32 || point === 127;
  });
}
