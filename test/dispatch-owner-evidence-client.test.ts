import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, createRouterTransport } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import {
  DispatchOwnerEvidenceKind,
  DispatchOwnerEvidenceSchema,
  DispatchOwnerEvidenceService,
  DispatchOwnerEvidenceNotFoundSchema,
  GetDispatchOwnerEvidenceResponseSchema,
} from "../src/generated/proto/kokoro/session/dispatch/v1/dispatch_owner_evidence_pb.js";
import {
  buildSessionDispatchOwnerEvidenceTransportOptions,
  createSessionDispatchOwnerEvidenceClientForTransport,
  SessionDispatchOwnerEvidenceLookupError,
} from "../src/interfaces/connect/dispatch-owner-evidence-client.js";
import {
  requireDispatchOwnerEvidence,
  type DispatchOwnerEvidenceLookup,
} from "../src/modules/admission/application/dispatch-owner-evidence.js";

const request = Object.freeze({
  siteId: "site-a",
  sessionId: "session-a",
  evidenceRef: "session-dispatch-evidence:v1:abc",
});

function foundTransport(
  overrides: Partial<Parameters<typeof create<typeof DispatchOwnerEvidenceSchema>>[1]> = {},
) {
  return createRouterTransport((router) => {
    router.service(DispatchOwnerEvidenceService, {
      getDispatchOwnerEvidence: (received) => create(GetDispatchOwnerEvidenceResponseSchema, {
        outcome: {
          case: "evidence",
          value: create(DispatchOwnerEvidenceSchema, {
            evidenceRef: received.evidenceRef,
            evidenceVersion: 1n,
            kind: DispatchOwnerEvidenceKind.NO_DISPATCH,
            siteId: received.siteId,
            sessionId: received.sessionId,
            dispatchId: "dispatch-a",
            launchId: "launch-a",
            runId: "run-a",
            authorizationSegmentRef: "segment-a",
            authorizationSegmentVersion: 9_007_199_254_740_993n,
            leaseGeneration: 9_007_199_254_740_995n,
            payloadSha256: "a".repeat(64),
            recordedAt: timestampFromDate(new Date("2026-07-29T12:34:56.789Z")),
            ...overrides,
          }),
        },
      }),
    });
  });
}

describe("Session dispatch-owner evidence consumer", () => {
  it("maps exact owner evidence without losing uint64 precision", async () => {
    const lookup = createSessionDispatchOwnerEvidenceClientForTransport(foundTransport());

    await expect(lookup.get(request, new AbortController().signal)).resolves.toEqual({
      kind: "found",
      evidence: {
        evidenceRef: request.evidenceRef,
        evidenceVersion: "1",
        kind: "no_dispatch",
        siteId: request.siteId,
        sessionId: request.sessionId,
        dispatchId: "dispatch-a",
        launchId: "launch-a",
        runId: "run-a",
        authorizationSegmentRef: "segment-a",
        authorizationSegmentVersion: "9007199254740993",
        leaseGeneration: "9007199254740995",
        payloadSha256: "a".repeat(64),
        recordedAt: "2026-07-29T12:34:56.789Z",
      },
    });
  });

  it("returns the typed not-found outcome", async () => {
    const lookup = createSessionDispatchOwnerEvidenceClientForTransport(createRouterTransport((router) => {
      router.service(DispatchOwnerEvidenceService, {
        getDispatchOwnerEvidence: () => create(GetDispatchOwnerEvidenceResponseSchema, {
          outcome: {
            case: "notFound",
            value: create(DispatchOwnerEvidenceNotFoundSchema),
          },
        }),
      });
    }));

    await expect(lookup.get(request, new AbortController().signal)).resolves.toEqual({ kind: "not_found" });
  });

  it("fails closed when the Session response identity does not match the exact query", async () => {
    const lookup = createSessionDispatchOwnerEvidenceClientForTransport(foundTransport({ siteId: "site-b" }));

    await expect(lookup.get(request, new AbortController().signal)).rejects.toMatchObject({
      name: "SessionDispatchOwnerEvidenceLookupError",
      code: "invalid_response",
      message: "SESSION_DISPATCH_OWNER_EVIDENCE_RESPONSE_INVALID",
    });
  });

  it("does not expose upstream error details and preserves cancellation", async () => {
    const unavailable = createSessionDispatchOwnerEvidenceClientForTransport(createRouterTransport((router) => {
      router.service(DispatchOwnerEvidenceService, {
        getDispatchOwnerEvidence: () => {
          throw new ConnectError("upstream private detail", Code.Internal);
        },
      });
    }));
    const canceled = new AbortController();
    canceled.abort();

    await expect(unavailable.get(request, new AbortController().signal)).rejects.toEqual(
      new SessionDispatchOwnerEvidenceLookupError("unavailable"),
    );
    await expect(unavailable.get(request, canceled.signal)).rejects.toEqual(
      new SessionDispatchOwnerEvidenceLookupError("canceled"),
    );
  });

  it("requires exact Platform-owned run and authorization identities", async () => {
    const lookup: DispatchOwnerEvidenceLookup =
      createSessionDispatchOwnerEvidenceClientForTransport(foundTransport());
    const result = await lookup.get(request, new AbortController().signal);

    expect(requireDispatchOwnerEvidence(result, {
      kind: "no_dispatch",
      siteId: request.siteId,
      sessionId: request.sessionId,
      evidenceRef: request.evidenceRef,
      launchId: "launch-a",
      runId: "run-a",
      authorizationSegmentRef: "segment-a",
      authorizationSegmentVersion: "9007199254740993",
    })).toMatchObject({ dispatchId: "dispatch-a" });
    expect(() => requireDispatchOwnerEvidence(result, {
      kind: "no_dispatch",
      siteId: request.siteId,
      sessionId: request.sessionId,
      evidenceRef: request.evidenceRef,
      launchId: "launch-a",
      runId: "run-b",
      authorizationSegmentRef: "segment-a",
      authorizationSegmentVersion: "9007199254740993",
    })).toThrowError("DISPATCH_OWNER_EVIDENCE_IDENTITY_MISMATCH");
  });

  it("builds an HTTP/2 TLS 1.3 fail-closed transport bounded to five seconds and 8 KiB", () => {
    const options = buildSessionDispatchOwnerEvidenceTransportOptions({
      baseUrl: "https://kokoro-session.internal/",
      serverName: "kokoro-session.internal",
      certificatePem: "-----BEGIN CERTIFICATE-----\nclient\n-----END CERTIFICATE-----",
      privateKeyPem: "-----BEGIN PRIVATE KEY-----\nclient\n-----END PRIVATE KEY-----",
      certificateAuthorityPem: "-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----",
      timeoutMs: 4_000,
    });

    expect(options).toMatchObject({
      baseUrl: "https://kokoro-session.internal",
      httpVersion: "2",
      useBinaryFormat: true,
      defaultTimeoutMs: 4_000,
      readMaxBytes: 8 * 1024,
      writeMaxBytes: 8 * 1024,
      acceptCompression: [],
      nodeOptions: {
        servername: "kokoro-session.internal",
        rejectUnauthorized: true,
        minVersion: "TLSv1.3",
      },
    });
    expect(buildSessionDispatchOwnerEvidenceTransportOptions({
      baseUrl: "https://kokoro-session.internal",
      serverName: "kokoro-session.internal",
      certificatePem: "-----BEGIN CERTIFICATE-----\nclient\n-----END CERTIFICATE-----",
      privateKeyPem: "-----BEGIN PRIVATE KEY-----\nclient\n-----END PRIVATE KEY-----",
      certificateAuthorityPem: "-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----",
    }).baseUrl).toBe("https://kokoro-session.internal");
    expect(() => buildSessionDispatchOwnerEvidenceTransportOptions({
      baseUrl: "http://kokoro-session.internal",
      serverName: "kokoro-session.internal",
      certificatePem: "-----BEGIN CERTIFICATE-----\nclient\n-----END CERTIFICATE-----",
      privateKeyPem: "-----BEGIN PRIVATE KEY-----\nclient\n-----END PRIVATE KEY-----",
      certificateAuthorityPem: "-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----",
    })).toThrowError("SESSION_DISPATCH_OWNER_EVIDENCE_MTLS_CONFIG_INVALID");
    expect(() => buildSessionDispatchOwnerEvidenceTransportOptions({
      baseUrl: "https://kokoro-session.internal",
      serverName: "kokoro-session.internal",
      certificatePem: "-----BEGIN CERTIFICATE-----\nclient\n-----END CERTIFICATE-----",
      privateKeyPem: "-----BEGIN PRIVATE KEY-----\nclient\n-----END PRIVATE KEY-----",
      certificateAuthorityPem: "-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----",
      timeoutMs: 5_001,
    })).toThrowError("SESSION_DISPATCH_OWNER_EVIDENCE_MTLS_CONFIG_INVALID");
  });
});
