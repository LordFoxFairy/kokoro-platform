import { createValidator } from "@bufbuild/protovalidate";
import { createClient, type Transport } from "@connectrpc/connect";
import { createConnectTransport, type ConnectTransportOptions } from "@connectrpc/connect-node";
import { AdmissionRetryClass } from "./generated/kokoro/platform/admission/v1/admission_pb.js";
import {
  SessionAdmissionOwnerService,
  VerifyFinalizeOwnerResponseSchema,
  VerifyPrepareOwnerResponseSchema,
  type SessionAdmissionOwnerMismatch,
  type SessionAdmissionOwnerNotReady,
} from "./generated-session-admission-owner/kokoro/session/admission/v1/session_admission_owner_pb.js";
import type {
  AdmissionOwnerResolution,
  AdmissionSessionOwnerPort,
} from "../../modules/admission/application/platform-admission-owner-authority.js";

const VALIDATOR = createValidator();

export type SessionAdmissionOwnerMtlsConfig = Readonly<{
  baseUrl: string;
  serverName: string;
  certificatePem: string;
  privateKeyPem: string;
  certificateAuthorityPem: string;
  timeoutMs?: number;
}>;

export class SessionAdmissionOwnerLookupError extends Error {
  readonly code: "canceled" | "unavailable" | "invalid_response";

  constructor(code: "canceled" | "unavailable" | "invalid_response") {
    super(code === "invalid_response"
      ? "SESSION_ADMISSION_OWNER_RESPONSE_INVALID"
      : `SESSION_ADMISSION_OWNER_${code.toUpperCase()}`);
    this.name = "SessionAdmissionOwnerLookupError";
    this.code = code;
  }
}

export function buildSessionAdmissionOwnerTransportOptions(
  config: SessionAdmissionOwnerMtlsConfig,
): ConnectTransportOptions {
  let parsed: URL;
  try {
    parsed = new URL(config.baseUrl);
  } catch {
    throw new Error("SESSION_ADMISSION_OWNER_MTLS_CONFIG_INVALID");
  }
  const timeoutMs = config.timeoutMs ?? 5_000;
  const normalizedUrl = parsed.href.endsWith("/") ? parsed.href.slice(0, -1) : parsed.href;
  const suppliedUrl = config.baseUrl.endsWith("/") ? config.baseUrl.slice(0, -1) : config.baseUrl;
  if (
    parsed.protocol !== "https:" || parsed.pathname !== "/" || parsed.username !== "" ||
    parsed.password !== "" || parsed.search !== "" || parsed.hash !== "" || normalizedUrl !== suppliedUrl ||
    !hostname(config.serverName) || !certificate(config.certificatePem) ||
    !privateKey(config.privateKeyPem) || !certificate(config.certificateAuthorityPem) ||
    !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5_000
  ) throw new Error("SESSION_ADMISSION_OWNER_MTLS_CONFIG_INVALID");
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

export function createSessionAdmissionOwnerClientForTransport(
  transport: Transport,
): AdmissionSessionOwnerPort {
  const client = createClient(SessionAdmissionOwnerService, transport);
  const owner: AdmissionSessionOwnerPort = {
    async resolve(input, signal) {
      try {
        const response = await client.verifyPrepareOwner({
          siteId: input.siteId,
          projectRef: input.projectRef,
          sessionId: input.sessionId,
          launchId: input.launchId,
          proposedRunId: input.runId,
          triggerMessageId: input.triggerMessageId,
          admissionCommandId: input.commandId,
          admissionRequestDigest: input.requestDigest,
        }, { signal });
        if (VALIDATOR.validate(VerifyPrepareOwnerResponseSchema, response).kind !== "valid") {
          throw invalidResponse();
        }
        if (response.outcome.case === "verified") {
          if (!reference(response.outcome.value.threadId, 128)) throw invalidResponse();
          return Object.freeze({
            kind: "resolved" as const,
            value: Object.freeze({ threadId: response.outcome.value.threadId }),
          });
        }
        return mapNonVerified(response.outcome);
      } catch (error) {
        throw mapError(error, signal);
      }
    },

    async verifyFinalizeReceipts(input, signal) {
      try {
        const response = await client.verifyFinalizeOwner({
          siteId: input.siteId,
          sessionId: input.sessionId,
          launchId: input.launchId,
          manifestRef: input.manifestRef,
          authorizationSegmentRef: input.authorizationSegmentRef,
          expectedSegmentVersion: input.expectedSegmentVersion,
          sessionIntentReceiptRef: input.sessionIntentReceiptRef,
          admissionCommandId: input.commandId,
          admissionRequestDigest: input.requestDigest,
        }, { signal });
        if (VALIDATOR.validate(VerifyFinalizeOwnerResponseSchema, response).kind !== "valid") {
          throw invalidResponse();
        }
        if (response.outcome.case === "verified") return Object.freeze({ kind: "verified" as const });
        return mapNonVerified(response.outcome);
      } catch (error) {
        throw mapError(error, signal);
      }
    },
  };
  return Object.freeze(owner);
}

export function createSessionAdmissionOwnerClient(
  config: SessionAdmissionOwnerMtlsConfig,
): AdmissionSessionOwnerPort {
  return createSessionAdmissionOwnerClientForTransport(
    createConnectTransport(buildSessionAdmissionOwnerTransportOptions(config)),
  );
}

function mapNonVerified(
  outcome:
    | Readonly<{ case: "mismatch"; value: SessionAdmissionOwnerMismatch }>
    | Readonly<{ case: "notReady"; value: SessionAdmissionOwnerNotReady }>
    | Readonly<{ case: undefined; value?: undefined }>,
): Exclude<AdmissionOwnerResolution<never>, Readonly<{ kind: "resolved" }>> {
  if (outcome.case === "mismatch" && code(outcome.value.code)) {
    return Object.freeze({
      kind: "denied" as const,
      denial: Object.freeze({ code: outcome.value.code, retryClass: AdmissionRetryClass.NEVER }),
    });
  }
  if (outcome.case === "notReady" && code(outcome.value.code) && validTimestamp(outcome.value.retryAfter)) {
    return Object.freeze({
      kind: "pending" as const,
      pending: Object.freeze({ retryAfter: outcome.value.retryAfter }),
    });
  }
  throw invalidResponse();
}

function mapError(error: unknown, signal: AbortSignal): SessionAdmissionOwnerLookupError {
  if (error instanceof SessionAdmissionOwnerLookupError) return error;
  return new SessionAdmissionOwnerLookupError(signal.aborted ? "canceled" : "unavailable");
}

function invalidResponse(): SessionAdmissionOwnerLookupError {
  return new SessionAdmissionOwnerLookupError("invalid_response");
}

function code(value: string): boolean {
  return /^[A-Z0-9_]{1,128}$/u.test(value);
}

function reference(value: string, maximum: number): boolean {
  return value.length > 0 && value.length <= maximum && value.trim() === value;
}

function hostname(value: string): boolean {
  return value.length > 0 && value.length <= 253 && value.trim() === value && !/[/:@\s]/u.test(value);
}

function certificate(value: string): boolean {
  return value.includes("-----BEGIN CERTIFICATE-----") && value.includes("-----END CERTIFICATE-----");
}

function privateKey(value: string): boolean {
  return value.includes("-----BEGIN PRIVATE KEY-----") && value.includes("-----END PRIVATE KEY-----");
}

function validTimestamp(value: Readonly<{ seconds: bigint; nanos: number }> | undefined): boolean {
  return value !== undefined && Number.isInteger(value.nanos) && value.nanos >= 0 && value.nanos <= 999_999_999 &&
    value.seconds >= -8_640_000_000_000n && value.seconds <= 8_640_000_000_000n;
}
