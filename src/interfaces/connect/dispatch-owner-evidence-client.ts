import { createClient, type Transport } from "@connectrpc/connect";
import { createConnectTransport, type ConnectTransportOptions } from "@connectrpc/connect-node";
import {
  DispatchOwnerEvidenceKind,
  DispatchOwnerEvidenceService,
  type DispatchOwnerEvidence as WireDispatchOwnerEvidence,
} from "../../generated/proto/kokoro/session/dispatch/v1/dispatch_owner_evidence_pb.js";
import type {
  DispatchOwnerEvidence,
  DispatchOwnerEvidenceLookup,
} from "../../modules/admission/application/dispatch-owner-evidence.js";

export type SessionDispatchOwnerEvidenceMtlsConfig = Readonly<{
  baseUrl: string;
  serverName: string;
  certificatePem: string;
  privateKeyPem: string;
  certificateAuthorityPem: string;
  timeoutMs?: number;
}>;

export class SessionDispatchOwnerEvidenceLookupError extends Error {
  readonly code: "canceled" | "unavailable" | "invalid_response";

  constructor(code: "canceled" | "unavailable" | "invalid_response") {
    super(code === "invalid_response"
      ? "SESSION_DISPATCH_OWNER_EVIDENCE_RESPONSE_INVALID"
      : `SESSION_DISPATCH_OWNER_EVIDENCE_${code.toUpperCase()}`);
    this.name = "SessionDispatchOwnerEvidenceLookupError";
    this.code = code;
  }
}

export function buildSessionDispatchOwnerEvidenceTransportOptions(
  config: SessionDispatchOwnerEvidenceMtlsConfig,
): ConnectTransportOptions {
  let parsed: URL;
  try {
    parsed = new URL(config.baseUrl);
  } catch {
    throw new Error("SESSION_DISPATCH_OWNER_EVIDENCE_MTLS_CONFIG_INVALID");
  }
  const timeoutMs = config.timeoutMs ?? 5_000;
  const normalizedUrl = parsed.href.endsWith("/") ? parsed.href.slice(0, -1) : parsed.href;
  const suppliedUrl = config.baseUrl.endsWith("/") ? config.baseUrl.slice(0, -1) : config.baseUrl;
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    normalizedUrl !== suppliedUrl ||
    config.serverName.length < 1 ||
    config.serverName.length > 253 ||
    config.serverName.trim() !== config.serverName ||
    !config.certificatePem.includes("-----BEGIN CERTIFICATE-----") ||
    !config.privateKeyPem.includes("-----BEGIN PRIVATE KEY-----") ||
    !config.certificateAuthorityPem.includes("-----BEGIN CERTIFICATE-----") ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 5_000
  ) {
    throw new Error("SESSION_DISPATCH_OWNER_EVIDENCE_MTLS_CONFIG_INVALID");
  }
  return {
    baseUrl: normalizedUrl,
    httpVersion: "2",
    useBinaryFormat: true,
    defaultTimeoutMs: timeoutMs,
    readMaxBytes: 8 * 1024,
    writeMaxBytes: 8 * 1024,
    acceptCompression: [],
    nodeOptions: {
      ca: config.certificateAuthorityPem,
      cert: config.certificatePem,
      key: config.privateKeyPem,
      servername: config.serverName,
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
    },
  };
}

export function createSessionDispatchOwnerEvidenceClientForTransport(
  transport: Transport,
): DispatchOwnerEvidenceLookup {
  const client = createClient(DispatchOwnerEvidenceService, transport);
  const lookup: DispatchOwnerEvidenceLookup = {
    async get(request, signal) {
      let response;
      try {
        response = await client.getDispatchOwnerEvidence(request, { signal });
      } catch {
        throw new SessionDispatchOwnerEvidenceLookupError(
          signal.aborted ? "canceled" : "unavailable",
        );
      }
      if (response.outcome.case === "notFound") {
        return Object.freeze({ kind: "not_found" as const });
      }
      if (response.outcome.case !== "evidence") {
        throw new SessionDispatchOwnerEvidenceLookupError("invalid_response");
      }
      return Object.freeze({
        kind: "found" as const,
        evidence: mapEvidence(response.outcome.value, request),
      });
    },
  };
  return Object.freeze(lookup);
}

export function createSessionDispatchOwnerEvidenceClient(
  config: SessionDispatchOwnerEvidenceMtlsConfig,
): DispatchOwnerEvidenceLookup {
  return createSessionDispatchOwnerEvidenceClientForTransport(
    createConnectTransport(buildSessionDispatchOwnerEvidenceTransportOptions(config)),
  );
}

function mapEvidence(
  value: WireDispatchOwnerEvidence,
  request: Readonly<{ siteId: string; sessionId: string; evidenceRef: string }>,
): DispatchOwnerEvidence {
  const kind = value.kind === DispatchOwnerEvidenceKind.NO_DISPATCH
    ? "no_dispatch"
    : value.kind === DispatchOwnerEvidenceKind.OUTCOME_UNKNOWN
      ? "outcome_unknown"
      : undefined;
  if (
    value.evidenceVersion !== 1n ||
    kind === undefined ||
    value.siteId !== request.siteId ||
    value.sessionId !== request.sessionId ||
    value.evidenceRef !== request.evidenceRef ||
    !reference(value.evidenceRef, 256) ||
    !reference(value.siteId, 128) ||
    !reference(value.sessionId, 128) ||
    !reference(value.dispatchId, 128) ||
    !reference(value.launchId, 128) ||
    !reference(value.runId, 128) ||
    !reference(value.authorizationSegmentRef, 256) ||
    value.authorizationSegmentVersion < 1n ||
    value.leaseGeneration < 1n ||
    !/^[0-9a-f]{64}$/u.test(value.payloadSha256)
  ) {
    throw new SessionDispatchOwnerEvidenceLookupError("invalid_response");
  }
  return Object.freeze({
    evidenceRef: value.evidenceRef,
    evidenceVersion: "1",
    kind,
    siteId: value.siteId,
    sessionId: value.sessionId,
    dispatchId: value.dispatchId,
    launchId: value.launchId,
    runId: value.runId,
    authorizationSegmentRef: value.authorizationSegmentRef,
    authorizationSegmentVersion: value.authorizationSegmentVersion.toString(),
    leaseGeneration: value.leaseGeneration.toString(),
    payloadSha256: value.payloadSha256,
    recordedAt: requiredTimestamp(value.recordedAt),
  });
}

function reference(value: string, maximumLength: number): boolean {
  return value.length > 0 && value.length <= maximumLength && value.trim() === value;
}

function requiredTimestamp(value: { seconds: bigint; nanos: number } | undefined): string {
  if (
    value === undefined ||
    value.nanos < 0 ||
    value.nanos > 999_999_999 ||
    !Number.isInteger(value.nanos) ||
    value.seconds < -8_640_000_000_000n ||
    value.seconds > 8_640_000_000_000n
  ) {
    throw new SessionDispatchOwnerEvidenceLookupError("invalid_response");
  }
  const wholeSecond = new Date(Number(value.seconds) * 1_000).toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/u.test(wholeSecond)) {
    throw new SessionDispatchOwnerEvidenceLookupError("invalid_response");
  }
  if (value.nanos === 0) return wholeSecond;
  const fraction = value.nanos.toString().padStart(9, "0").replace(/0+$/u, "");
  return `${wholeSecond.slice(0, -5)}.${fraction}Z`;
}
