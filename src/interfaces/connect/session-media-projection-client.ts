import { createHash } from "node:crypto";
import { createValidator } from "@bufbuild/protovalidate";
import { createClient, type Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { timestampFromDate, timestampDate } from "@bufbuild/protobuf/wkt";
import type { AdmissionMediaProjectionOwnerPort } from
  "../../modules/admission/application/platform-admission-owner-authority.js";
import {
  IssueMediaProjectionReservationResponseSchema,
  ProjectionCommandKind,
  SessionMediaProjectionService,
  type ProjectionCommandResolution,
} from "../../generated/proto/kokoro/session/media/v1/media_projection_pb.js";
import {
  buildSessionAdmissionOwnerTransportOptions,
  type SessionAdmissionOwnerMtlsConfig,
} from "./session-admission-owner-client.js";

const VALIDATOR = createValidator();

export class SessionMediaProjectionClientError extends Error {
  readonly code: "canceled" | "unavailable" | "invalid_response";
  constructor(code: "canceled" | "unavailable" | "invalid_response") {
    super(code === "invalid_response" ? "SESSION_MEDIA_PROJECTION_RESPONSE_INVALID"
      : `SESSION_MEDIA_PROJECTION_${code.toUpperCase()}`);
    this.name = "SessionMediaProjectionClientError";
    this.code = code;
  }
}

export function createSessionMediaProjectionClientForTransport(
  transport: Transport,
): AdmissionMediaProjectionOwnerPort {
  const client = createClient(SessionMediaProjectionService, transport);
  const owner: AdmissionMediaProjectionOwnerPort = {
    async issueReservation(input, signal) {
      try {
        const response = await client.issueMediaProjectionReservation({
          sessionProjectionAuthorizationHandle: input.sessionProjectionAuthorizationHandle,
          sessionId: input.sessionId,
          runId: input.runId,
          assistantMessageId: input.assistantMessageId,
          subjectGeneration: input.subjectGeneration,
          maximumSlots: input.maximumSlots,
          projectionCommandRef: input.projectionCommandRef,
          projectionCommandRecoveryCapability: input.projectionCommandRecoveryCapability,
        }, { signal });
        if (VALIDATOR.validate(IssueMediaProjectionReservationResponseSchema, response).kind !== "valid" ||
            response.resolution === undefined) throw invalidResponse();
        let resolution = response.resolution;
        if (resolution.receipt?.outcome.case === "outcomeUnknown") {
          const recovered = await client.recoverProjectionCommand({
            projectionCommandRef: input.projectionCommandRef,
            projectionCommandRecoveryCapability: input.projectionCommandRecoveryCapability,
          }, { signal });
          if (recovered.resolution === undefined) throw invalidResponse();
          resolution = recovered.resolution;
        }
        return mapResolution(resolution, input.projectionCommandRef);
      } catch (error) {
        if (error instanceof SessionMediaProjectionClientError) throw error;
        throw new SessionMediaProjectionClientError(signal.aborted ? "canceled" : "unavailable");
      }
    },
  };
  return Object.freeze(owner);
}

export function createSessionMediaProjectionClient(
  config: SessionAdmissionOwnerMtlsConfig,
): AdmissionMediaProjectionOwnerPort {
  return createSessionMediaProjectionClientForTransport(
    createConnectTransport(buildSessionAdmissionOwnerTransportOptions(config)),
  );
}

function mapResolution(
  resolution: ProjectionCommandResolution,
  expectedCommandRef: string,
): Awaited<ReturnType<AdmissionMediaProjectionOwnerPort["issueReservation"]>> {
  const outcome = resolution.receipt?.outcome;
  if (outcome === undefined || outcome.case === undefined ||
      outcome.value.commandKind !== ProjectionCommandKind.ISSUE_MEDIA_PROJECTION_RESERVATION ||
      outcome.value.projectionCommandRef !== expectedCommandRef || outcome.value.receiptVersion < 1n) {
    throw invalidResponse();
  }
  if (outcome.case === "rejected") {
    if (!/^[A-Z0-9_]{1,128}$/u.test(outcome.value.safeErrorCode)) throw invalidResponse();
    return Object.freeze({ kind: "denied" as const,
      denial: Object.freeze({ code: outcome.value.safeErrorCode, retryClass: 1 }) });
  }
  if (outcome.case === "outcomeUnknown") {
    const recordedAt = requiredTimestamp(outcome.value.recordedAt);
    return Object.freeze({ kind: "pending" as const,
      pending: Object.freeze({ retryAfter: timestampFromDate(new Date(Date.parse(recordedAt) + 1_000)) }) });
  }
  if (resolution.result.case !== "issueResult" || resolution.result.value.reservation === undefined) {
    throw invalidResponse();
  }
  const reservation = resolution.result.value.reservation;
  if (!reference(reservation.mediaProjectionReservationHandle, 8192)) throw invalidResponse();
  const expiresAt = requiredTimestamp(reservation.expiresAt);
  if (Date.parse(expiresAt) <= Date.parse(requiredTimestamp(outcome.value.recordedAt))) throw invalidResponse();
  return Object.freeze({ kind: "resolved" as const, value: Object.freeze({
    mediaProjectionReservationHandle: reservation.mediaProjectionReservationHandle,
    expiresAt,
    reservationReceiptRef: `media-projection-reservation-receipt:sha256:${createHash("sha256")
      .update("kokoro.session.media-projection-reservation-receipt.v1\0")
      .update(outcome.value.projectionCommandRef).update("\0")
      .update(outcome.value.receiptVersion.toString()).update("\0")
      .update(requiredTimestamp(outcome.value.recordedAt)).digest("hex")}`,
  }) });
}

function requiredTimestamp(value: Parameters<typeof timestampDate>[0] | undefined): string {
  if (value === undefined) throw invalidResponse();
  try { return timestampDate(value).toISOString(); } catch { throw invalidResponse(); }
}

function reference(value: string, maximum: number): boolean {
  return value.length >= 1 && value.length <= maximum && value.trim() === value;
}

function invalidResponse(): SessionMediaProjectionClientError {
  return new SessionMediaProjectionClientError("invalid_response");
}
