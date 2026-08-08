import { create, type DescMessage, type Message } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { createRouterTransport } from "@connectrpc/connect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const validationState = vi.hoisted(() => ({ calls: 0 }));

vi.mock("@bufbuild/protovalidate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@bufbuild/protovalidate")>();
  return {
    ...actual,
    createValidator: () => ({
      validate(_schema: DescMessage, message: Message) {
        validationState.calls += 1;
        if (validationState.calls === 1) {
          return { kind: "valid" as const, message, error: undefined, violations: undefined };
        }
        return {
          kind: "error" as const,
          message,
          error: new actual.RuntimeError("validator runtime failed"),
          violations: undefined,
        };
      },
    }),
  };
});

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

function acceptedIssueResolution() {
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
          mediaProjectionReservationHandle: "reservation." + "h".repeat(64),
          expiresAt: timestampFromDate(new Date("2026-08-07T12:02:00.000Z")),
          credentialRotation: create(ProjectionCredentialRotationSchema, {
            envelopeGeneration: 1n,
            previousCredentialsInvalidated: false,
          }),
        }),
      }),
    },
  });
}

describe("Session Media Projection validator failure classification", () => {
  beforeEach(() => { validationState.calls = 0; });

  it("classifies a recovery validator runtime error as unavailable", async () => {
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

    await expect(client.issueReservation(input, new AbortController().signal)).rejects.toMatchObject({
      code: "unavailable",
      message: "SESSION_MEDIA_PROJECTION_UNAVAILABLE",
    });
    expect(recoverProjectionCommand).toHaveBeenCalledTimes(1);
    expect(validationState.calls).toBe(2);
  });
});
