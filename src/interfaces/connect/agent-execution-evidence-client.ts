import { createHash, timingSafeEqual } from "node:crypto";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { createValidator } from "@bufbuild/protovalidate";
import { createClient, type Transport } from "@connectrpc/connect";
import { createConnectTransport, type ConnectTransportOptions } from "@connectrpc/connect-node";
import {
  AgentExecutionEvidenceService,
  DurableExecutionCanonicalPayloadV1Schema,
  DurableExecutionEvidenceKind,
  DurableExecutionEvidenceSchema,
  type DurableExecutionCanonicalPayloadV1,
  type DurableExecutionEvidence,
} from "./generated-agent-evidence/kokoro/agent/execution/v1/agent_execution_evidence_pb.js";
import type {
  AdmissionExecutionEvidence,
  AdmissionExecutionEvidenceOwnerPort,
} from "../../modules/admission/application/platform-admission-owner-authority.js";

const PROTO_VALIDATOR = createValidator();

export type AgentExecutionEvidenceMtlsConfig = Readonly<{
  baseUrl: string;
  serverName: string;
  certificatePem: string;
  privateKeyPem: string;
  certificateAuthorityPem: string;
  timeoutMs?: number;
}>;

export class AgentExecutionEvidenceLookupError extends Error {
  readonly code: "canceled" | "unavailable" | "invalid_response";

  constructor(code: "canceled" | "unavailable" | "invalid_response") {
    super(code === "invalid_response"
      ? "AGENT_EXECUTION_EVIDENCE_RESPONSE_INVALID"
      : `AGENT_EXECUTION_EVIDENCE_${code.toUpperCase()}`);
    this.name = "AgentExecutionEvidenceLookupError";
    this.code = code;
  }
}

export function buildAgentExecutionEvidenceTransportOptions(
  config: AgentExecutionEvidenceMtlsConfig,
): ConnectTransportOptions {
  let parsed: URL;
  try {
    parsed = new URL(config.baseUrl);
  } catch {
    throw new Error("AGENT_EXECUTION_EVIDENCE_MTLS_CONFIG_INVALID");
  }
  const timeoutMs = config.timeoutMs ?? 5_000;
  const normalizedUrl = parsed.href.endsWith("/") ? parsed.href.slice(0, -1) : parsed.href;
  const suppliedUrl = config.baseUrl.endsWith("/") ? config.baseUrl.slice(0, -1) : config.baseUrl;
  if (
    parsed.protocol !== "https:" || parsed.pathname !== "/" || parsed.username !== "" || parsed.password !== "" ||
    parsed.search !== "" || parsed.hash !== "" || normalizedUrl !== suppliedUrl ||
    !hostname(config.serverName) || !certificate(config.certificatePem) ||
    !privateKey(config.privateKeyPem) || !certificate(config.certificateAuthorityPem) ||
    !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5_000
  ) throw new Error("AGENT_EXECUTION_EVIDENCE_MTLS_CONFIG_INVALID");
  return {
    baseUrl: normalizedUrl,
    httpVersion: "2",
    useBinaryFormat: true,
    defaultTimeoutMs: timeoutMs,
    readMaxBytes: 72 * 1024,
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

export function createAgentExecutionEvidenceClientForTransport(
  transport: Transport,
): AdmissionExecutionEvidenceOwnerPort {
  const client = createClient(AgentExecutionEvidenceService, transport);
  const owner: AdmissionExecutionEvidenceOwnerPort = {
    async resolve(
      input: Parameters<AdmissionExecutionEvidenceOwnerPort["resolve"]>[0],
      signal: AbortSignal,
    ): Promise<AdmissionExecutionEvidence> {
      const exactRef = exactEvidenceRef(input.gaDurableEventReceiptRef, input.terminalOwnerEvidenceRef);
      try {
        const outcome = exactRef === undefined
          ? (await client.getRunDurableCheckpoint({ runId: input.runId }, { signal })).outcome
          : (await client.getDurableExecutionEvidence({
              runId: input.runId,
              evidenceRef: exactRef,
            }, { signal })).outcome;
        if (outcome.case === "notFound") return Object.freeze({ kind: "not_found" as const });
        if (outcome.case !== "evidence") throw invalidResponse();
        return mapEvidence(outcome.value, input.runId, exactRef);
      } catch (error) {
        if (error instanceof AgentExecutionEvidenceLookupError) throw error;
        throw new AgentExecutionEvidenceLookupError(signal.aborted ? "canceled" : "unavailable");
      }
    },
  };
  return Object.freeze(owner);
}

export function createAgentExecutionEvidenceClient(
  config: AgentExecutionEvidenceMtlsConfig,
): AdmissionExecutionEvidenceOwnerPort {
  return createAgentExecutionEvidenceClientForTransport(
    createConnectTransport(buildAgentExecutionEvidenceTransportOptions(config)),
  );
}

function mapEvidence(
  evidence: DurableExecutionEvidence,
  expectedRunId: string,
  expectedEvidenceRef: string | undefined,
): AdmissionExecutionEvidence {
  if (
    PROTO_VALIDATOR.validate(DurableExecutionEvidenceSchema, evidence).kind !== "valid" ||
    evidence.evidenceVersion !== 1n || evidence.runId !== expectedRunId ||
    (expectedEvidenceRef !== undefined && evidence.evidenceRef !== expectedEvidenceRef) ||
    !reference(evidence.evidenceRef, 256) || !reference(evidence.runId, 128) ||
    !reference(evidence.eventId, 256) || !reference(evidence.producerInstanceRef, 256) ||
    evidence.durableSeq < 1n || evidence.producerGeneration < 1n ||
    evidence.canonicalPayload.byteLength > 64 * 1024 ||
    !/^[0-9a-f]{64}$/u.test(evidence.payloadSha256) ||
    !validTimestamp(evidence.recordedAt)
  ) throw invalidResponse();
  const actualDigest = createHash("sha256").update(evidence.canonicalPayload).digest();
  const declaredDigest = Buffer.from(evidence.payloadSha256, "hex");
  if (actualDigest.byteLength !== declaredDigest.byteLength || !timingSafeEqual(actualDigest, declaredDigest)) {
    throw invalidResponse();
  }
  let canonical: DurableExecutionCanonicalPayloadV1;
  try {
    canonical = fromBinary(DurableExecutionCanonicalPayloadV1Schema, evidence.canonicalPayload, {
      readUnknownFields: false,
    });
  } catch {
    throw invalidResponse();
  }
  if (
    PROTO_VALIDATOR.validate(DurableExecutionCanonicalPayloadV1Schema, canonical).kind !== "valid" ||
    !Buffer.from(toBinary(DurableExecutionCanonicalPayloadV1Schema, canonical, {
      writeUnknownFields: false,
    })).equals(Buffer.from(evidence.canonicalPayload)) ||
    !kindMatchesPayload(evidence.kind, canonical.payload.case)
  ) throw invalidResponse();
  return terminalKind(evidence.kind)
    ? Object.freeze({
        kind: "terminal_observed" as const,
        terminalEvidenceRef: evidence.evidenceRef,
        safeStatusRef: evidence.evidenceRef,
      })
    : Object.freeze({
        kind: "execution_observed" as const,
        safeStatusRef: evidence.evidenceRef,
      });
}

function kindMatchesPayload(
  kind: DurableExecutionEvidenceKind,
  payload: DurableExecutionCanonicalPayloadV1["payload"]["case"],
): boolean {
  return (kind === DurableExecutionEvidenceKind.RUN_STARTED && payload === "runStarted") ||
    (kind === DurableExecutionEvidenceKind.ACTION_OWNER && payload === "actionOwner") ||
    (kind === DurableExecutionEvidenceKind.PLAN_OWNER && payload === "planOwner") ||
    (kind === DurableExecutionEvidenceKind.RUN_OWNER_COMPLETED && payload === "runOwnerCompleted") ||
    (kind === DurableExecutionEvidenceKind.RUN_COMPLETED && payload === "runCompleted") ||
    (kind === DurableExecutionEvidenceKind.RUN_FAILED && payload === "runFailed");
}

function terminalKind(kind: DurableExecutionEvidenceKind): boolean {
  return kind === DurableExecutionEvidenceKind.RUN_COMPLETED || kind === DurableExecutionEvidenceKind.RUN_FAILED;
}

function exactEvidenceRef(first: string | undefined, second: string | undefined): string | undefined {
  if (first !== undefined && second !== undefined && first !== second) throw invalidResponse();
  const value = second ?? first;
  if (value !== undefined && !reference(value, 256)) throw invalidResponse();
  return value;
}

function invalidResponse(): AgentExecutionEvidenceLookupError {
  return new AgentExecutionEvidenceLookupError("invalid_response");
}

function reference(value: string, maximumLength: number): boolean {
  return value.length > 0 && value.length <= maximumLength && value.trim() === value;
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
