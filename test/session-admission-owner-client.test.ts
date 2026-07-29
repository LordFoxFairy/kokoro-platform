import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { createRouterTransport } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import { AdmissionRetryClass } from "../src/interfaces/connect/generated/kokoro/platform/admission/v1/admission_pb.js";
import {
  SessionAdmissionFinalizeOwnerVerifiedSchema,
  SessionAdmissionOwnerMismatchSchema,
  SessionAdmissionOwnerNotReadySchema,
  SessionAdmissionOwnerService,
  SessionAdmissionPrepareOwnerVerifiedSchema,
  VerifyFinalizeOwnerResponseSchema,
  VerifyPrepareOwnerResponseSchema,
} from "../src/interfaces/connect/generated-session-admission-owner/kokoro/session/admission/v1/session_admission_owner_pb.js";
import {
  SessionAdmissionOwnerLookupError,
  buildSessionAdmissionOwnerTransportOptions,
  createSessionAdmissionOwnerClientForTransport,
} from "../src/interfaces/connect/session-admission-owner-client.js";

const prepare = {
  siteId: "site-a",
  projectRef: "project-a",
  sessionId: "session-a",
  launchId: "launch-a",
  runId: "run-a",
  triggerMessageId: "message-a",
  commandId: "command-a",
  requestDigest: "d".repeat(64),
};

const finalize = {
  siteId: "site-a",
  sessionId: "session-a",
  launchId: "launch-a",
  manifestRef: "manifest-a",
  authorizationSegmentRef: "segment-a",
  expectedSegmentVersion: 1n,
  sessionIntentReceiptRef: "receipt-a",
  commandId: "command-finalize-a",
  requestDigest: "e".repeat(64),
};

describe("Session Admission owner Connect client", () => {
  it("consumes Session-owned thread identity without forwarding prompt or bearer data", async () => {
    let request: unknown;
    const client = createSessionAdmissionOwnerClientForTransport(createRouterTransport((router) => {
      router.service(SessionAdmissionOwnerService, {
        verifyPrepareOwner: (input) => {
          request = input;
          return create(VerifyPrepareOwnerResponseSchema, {
            outcome: {
              case: "verified",
              value: create(SessionAdmissionPrepareOwnerVerifiedSchema, { threadId: "thread-a" }),
            },
          });
        },
      });
    }));

    await expect(client.resolve(prepare, new AbortController().signal)).resolves.toEqual({
      kind: "resolved",
      value: { threadId: "thread-a" },
    });
    expect(request).toMatchObject({
      siteId: "site-a", projectRef: "project-a", sessionId: "session-a", launchId: "launch-a",
      proposedRunId: "run-a", triggerMessageId: "message-a", admissionCommandId: "command-a",
      admissionRequestDigest: "d".repeat(64),
    });
    expect(Object.keys(request as object)).not.toContain("sessionAccessGrant");
    expect(Object.keys(request as object)).not.toContain("triggerMessageContent");
  });

  it("verifies the exact finalize command and segment identity", async () => {
    let request: unknown;
    const client = createSessionAdmissionOwnerClientForTransport(createRouterTransport((router) => {
      router.service(SessionAdmissionOwnerService, {
        verifyFinalizeOwner: (input) => {
          request = input;
          return create(VerifyFinalizeOwnerResponseSchema, {
            outcome: {
              case: "verified",
              value: create(SessionAdmissionFinalizeOwnerVerifiedSchema),
            },
          });
        },
      });
    }));

    await expect(client.verifyFinalizeReceipts(finalize, new AbortController().signal))
      .resolves.toEqual({ kind: "verified" });
    expect(request).toMatchObject({
      siteId: "site-a", sessionId: "session-a", launchId: "launch-a", manifestRef: "manifest-a",
      authorizationSegmentRef: "segment-a", expectedSegmentVersion: 1n,
      sessionIntentReceiptRef: "receipt-a", admissionCommandId: "command-finalize-a",
      admissionRequestDigest: "e".repeat(64),
    });
  });

  it("maps owner mismatch and not-ready outcomes without widening retry semantics", async () => {
    const mismatch = createSessionAdmissionOwnerClientForTransport(createRouterTransport((router) => {
      router.service(SessionAdmissionOwnerService, {
        verifyPrepareOwner: () => create(VerifyPrepareOwnerResponseSchema, {
          outcome: {
            case: "mismatch",
            value: create(SessionAdmissionOwnerMismatchSchema, { code: "SESSION_LAUNCH_MISMATCH" }),
          },
        }),
      });
    }));
    await expect(mismatch.resolve(prepare, new AbortController().signal)).resolves.toEqual({
      kind: "denied",
      denial: { code: "SESSION_LAUNCH_MISMATCH", retryClass: AdmissionRetryClass.NEVER },
    });

    const retryAfter = timestampFromDate(new Date("2026-07-29T12:05:00.000Z"));
    const pending = createSessionAdmissionOwnerClientForTransport(createRouterTransport((router) => {
      router.service(SessionAdmissionOwnerService, {
        verifyFinalizeOwner: () => create(VerifyFinalizeOwnerResponseSchema, {
          outcome: {
            case: "notReady",
            value: create(SessionAdmissionOwnerNotReadySchema, {
              code: "SESSION_FINALIZE_NOT_READY", retryAfter,
            }),
          },
        }),
      });
    }));
    await expect(pending.verifyFinalizeReceipts(finalize, new AbortController().signal)).resolves.toEqual({
      kind: "pending",
      pending: { retryAfter },
    });
  });

  it("redacts upstream failures, preserves cancellation and rejects invalid owner identities", async () => {
    const invalid = createSessionAdmissionOwnerClientForTransport(createRouterTransport((router) => {
      router.service(SessionAdmissionOwnerService, {
        verifyPrepareOwner: () => create(VerifyPrepareOwnerResponseSchema, {
          outcome: {
            case: "verified",
            value: create(SessionAdmissionPrepareOwnerVerifiedSchema, { threadId: "" }),
          },
        }),
      });
    }));
    await expect(invalid.resolve(prepare, new AbortController().signal)).rejects.toEqual(
      new SessionAdmissionOwnerLookupError("invalid_response"),
    );

    const unavailable = createSessionAdmissionOwnerClientForTransport(createRouterTransport((router) => {
      router.service(SessionAdmissionOwnerService, {
        verifyPrepareOwner: () => { throw new Error("private database details"); },
      });
    }));
    await expect(unavailable.resolve(prepare, new AbortController().signal)).rejects.toEqual(
      new SessionAdmissionOwnerLookupError("unavailable"),
    );
    const canceled = new AbortController();
    canceled.abort();
    await expect(unavailable.resolve(prepare, canceled.signal)).rejects.toEqual(
      new SessionAdmissionOwnerLookupError("canceled"),
    );
  });

  it("builds a bounded HTTP/2 TLS 1.3 transport", () => {
    const tls = {
      serverName: "kokoro-session.internal",
      certificatePem: "-----BEGIN CERTIFICATE-----\nclient\n-----END CERTIFICATE-----",
      privateKeyPem: "-----BEGIN PRIVATE KEY-----\nclient\n-----END PRIVATE KEY-----",
      certificateAuthorityPem: "-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----",
    };
    expect(buildSessionAdmissionOwnerTransportOptions({
      baseUrl: "https://kokoro-session.internal/", ...tls,
    })).toMatchObject({
      baseUrl: "https://kokoro-session.internal", httpVersion: "2", useBinaryFormat: true,
      defaultTimeoutMs: 5_000, readMaxBytes: 8 * 1024, writeMaxBytes: 8 * 1024,
      nodeOptions: { servername: tls.serverName, rejectUnauthorized: true, minVersion: "TLSv1.3" },
    });
    expect(() => buildSessionAdmissionOwnerTransportOptions({
      baseUrl: "https://kokoro-session.internal/path", ...tls,
    })).toThrowError("SESSION_ADMISSION_OWNER_MTLS_CONFIG_INVALID");
  });
});
