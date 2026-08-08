import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { createRouterTransport } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";

import {
  IssueMediaProjectionReservationAcceptedResultSchema,
  IssueMediaProjectionReservationResponseSchema,
  ProjectionCommandAcceptedSchema,
  ProjectionCommandKind,
  ProjectionCommandOutcomeUnknownSchema,
  ProjectionCommandReceiptSchema,
  ProjectionCommandRecoveryAction,
  ProjectionCommandResolutionSchema,
  ProjectionCredentialRotationSchema,
  ProjectionReservationCredentialEnvelopeSchema,
  RecoverProjectionCommandResponseSchema,
  SessionMediaProjectionService,
} from "../src/generated/proto/kokoro/session/media/v1/media_projection_pb.js";
import {
  createSessionMediaProjectionClientForTransport,
} from "../src/interfaces/connect/session-media-projection-client.js";

const input = Object.freeze({
  sessionProjectionAuthorizationHandle: "authorization." + "a".repeat(64),
  sessionId: "session-a",
  runId: "run-a",
  assistantMessageId: "assistant-a",
  subjectGeneration: 1n,
  maximumSlots: 16 as const,
  projectionCommandRef: "projection-command-a",
  projectionCommandRecoveryCapability: "r".repeat(43),
});

const recordedAt = new Date("2026-08-07T12:00:00.000Z");
const expiresAt = new Date("2026-08-07T12:02:00.000Z");
const reservationHandle = "reservation." + "h".repeat(64);

function acceptedIssueResolution(previousCredentialsInvalidated = false) {
  return create(ProjectionCommandResolutionSchema, {
    receipt: create(ProjectionCommandReceiptSchema, {
      outcome: {
        case: "accepted",
        value: create(ProjectionCommandAcceptedSchema, {
          projectionCommandRef: input.projectionCommandRef,
          receiptVersion: 1n,
          recoveryAction: ProjectionCommandRecoveryAction.RECOVER_COMMAND,
          recordedAt: timestampFromDate(recordedAt),
          commandKind: ProjectionCommandKind.ISSUE_MEDIA_PROJECTION_RESERVATION,
        }),
      },
    }),
    result: {
      case: "issueResult",
      value: create(IssueMediaProjectionReservationAcceptedResultSchema, {
        reservation: create(ProjectionReservationCredentialEnvelopeSchema, {
          mediaProjectionReservationHandle: reservationHandle,
          expiresAt: timestampFromDate(expiresAt),
          credentialRotation: create(ProjectionCredentialRotationSchema, {
            envelopeGeneration: 1n,
            previousCredentialsInvalidated,
          }),
        }),
      }),
    },
  });
}

function outcomeUnknownIssueResolution() {
  return create(ProjectionCommandResolutionSchema, {
    receipt: create(ProjectionCommandReceiptSchema, {
      outcome: {
        case: "outcomeUnknown",
        value: create(ProjectionCommandOutcomeUnknownSchema, {
          projectionCommandRef: input.projectionCommandRef,
          receiptVersion: 1n,
          recoveryAction: ProjectionCommandRecoveryAction.RECOVER_COMMAND,
          recordedAt: timestampFromDate(recordedAt),
          commandKind: ProjectionCommandKind.ISSUE_MEDIA_PROJECTION_RESERVATION,
        }),
      },
    }),
  });
}

function expectInvalidResponse(promise: ReturnType<
  ReturnType<typeof createSessionMediaProjectionClientForTransport>["issueReservation"]
>) {
  return expect(promise).rejects.toMatchObject({
    code: "invalid_response",
    message: "SESSION_MEDIA_PROJECTION_RESPONSE_INVALID",
  });
}

describe("Session Media Projection Connect client", () => {
  it("accepts the Session-owned reservation response emitted by the production authority", async () => {
    const client = createSessionMediaProjectionClientForTransport(createRouterTransport((router) => {
      router.service(SessionMediaProjectionService, {
        issueMediaProjectionReservation: () => create(IssueMediaProjectionReservationResponseSchema, {
          resolution: acceptedIssueResolution(),
        }),
      });
    }));

    await expect(client.issueReservation(input, new AbortController().signal)).resolves.toMatchObject({
      kind: "resolved",
      value: {
        mediaProjectionReservationHandle: reservationHandle,
        expiresAt: expiresAt.toISOString(),
        reservationReceiptRef: expect.stringMatching(
          /^media-projection-reservation-receipt:sha256:[a-f0-9]{64}$/u,
        ),
      },
    });
  });

  it("resolves a recovered accepted reservation and recovers exactly once", async () => {
    const recoverProjectionCommand = vi.fn(() => create(RecoverProjectionCommandResponseSchema, {
      resolution: acceptedIssueResolution(),
    }));
    const client = createSessionMediaProjectionClientForTransport(createRouterTransport((router) => {
      router.service(SessionMediaProjectionService, {
        issueMediaProjectionReservation: () => create(IssueMediaProjectionReservationResponseSchema, {
          resolution: outcomeUnknownIssueResolution(),
        }),
        recoverProjectionCommand,
      });
    }));

    await expect(client.issueReservation(input, new AbortController().signal)).resolves.toMatchObject({
      kind: "resolved",
      value: {
        mediaProjectionReservationHandle: reservationHandle,
        expiresAt: expiresAt.toISOString(),
      },
    });
    expect(recoverProjectionCommand).toHaveBeenCalledTimes(1);
  });

  it("rejects an initial response that violates the credential rotation CEL rule", async () => {
    const client = createSessionMediaProjectionClientForTransport(createRouterTransport((router) => {
      router.service(SessionMediaProjectionService, {
        issueMediaProjectionReservation: () => create(IssueMediaProjectionReservationResponseSchema, {
          resolution: acceptedIssueResolution(true),
        }),
      });
    }));

    await expectInvalidResponse(client.issueReservation(input, new AbortController().signal));
  });

  it("rejects a recovered response that violates the credential rotation CEL rule", async () => {
    const client = createSessionMediaProjectionClientForTransport(createRouterTransport((router) => {
      router.service(SessionMediaProjectionService, {
        issueMediaProjectionReservation: () => create(IssueMediaProjectionReservationResponseSchema, {
          resolution: outcomeUnknownIssueResolution(),
        }),
        recoverProjectionCommand: () => create(RecoverProjectionCommandResponseSchema, {
          resolution: acceptedIssueResolution(true),
        }),
      });
    }));

    await expectInvalidResponse(client.issueReservation(input, new AbortController().signal));
  });
});
