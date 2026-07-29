import { createHash } from "node:crypto";
import { create, toBinary } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, createRouterTransport } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import {
  AgentExecutionEvidenceService,
  DurableExecutionCanonicalPayloadV1Schema,
  DurableExecutionEvidenceKind,
  DurableExecutionEvidenceNotFoundSchema,
  DurableExecutionEvidenceSchema,
  GetDurableExecutionEvidenceResponseSchema,
  GetRunDurableCheckpointResponseSchema,
  RunCompletedEvidenceStatus,
  RunCompletedEvidenceV1Schema,
} from "../src/interfaces/connect/generated-agent-evidence/kokoro/agent/execution/v1/agent_execution_evidence_pb.js";
import {
  AgentExecutionEvidenceLookupError,
  buildAgentExecutionEvidenceTransportOptions,
  createAgentExecutionEvidenceClientForTransport,
} from "../src/interfaces/connect/agent-execution-evidence-client.js";

const runId = "run-a";
const evidenceRef = "agent-execution-evidence:v1:terminal-a";

function terminalEvidence(overrides: Readonly<Record<string, unknown>> = {}) {
  const canonicalPayload = toBinary(
    DurableExecutionCanonicalPayloadV1Schema,
    create(DurableExecutionCanonicalPayloadV1Schema, {
      payload: {
        case: "runCompleted",
        value: create(RunCompletedEvidenceV1Schema, {
          status: RunCompletedEvidenceStatus.COMPLETED,
          tokenUsage: { inputTokens: 5n, outputTokens: 8n },
        }),
      },
    }),
    { writeUnknownFields: false },
  );
  return create(DurableExecutionEvidenceSchema, {
    evidenceRef,
    evidenceVersion: 1n,
    runId,
    durableSeq: 9_007_199_254_740_993n,
    eventId: "event-a",
    kind: DurableExecutionEvidenceKind.RUN_COMPLETED,
    canonicalPayload,
    payloadSha256: createHash("sha256").update(canonicalPayload).digest("hex"),
    recordedAt: timestampFromDate(new Date("2026-07-29T12:34:56.789Z")),
    producerInstanceRef: "agent-instance-a",
    producerGeneration: 9_007_199_254_740_995n,
    ...overrides,
  });
}

function transportWithEvidence(overrides: Readonly<Record<string, unknown>> = {}) {
  return createRouterTransport((router) => {
    router.service(AgentExecutionEvidenceService, {
      getDurableExecutionEvidence: () => create(GetDurableExecutionEvidenceResponseSchema, {
        outcome: { case: "evidence", value: terminalEvidence(overrides) },
      }),
      getRunDurableCheckpoint: () => create(GetRunDurableCheckpointResponseSchema, {
        outcome: { case: "evidence", value: terminalEvidence(overrides) },
      }),
    });
  });
}

describe("Agent durable execution-evidence consumer", () => {
  it("resolves the exact referenced terminal owner fact without uint64 precision loss", async () => {
    const client = createAgentExecutionEvidenceClientForTransport(transportWithEvidence());

    await expect(client.resolve({
      siteId: "site-a",
      sessionId: "session-a",
      launchId: "launch-a",
      runId,
      terminalOwnerEvidenceRef: evidenceRef,
    }, new AbortController().signal)).resolves.toEqual({
      kind: "terminal_observed",
      terminalEvidenceRef: evidenceRef,
      safeStatusRef: evidenceRef,
    });
  });

  it("uses the Agent checkpoint only when no exact evidence ref was supplied", async () => {
    let exactCalls = 0;
    let checkpointCalls = 0;
    const client = createAgentExecutionEvidenceClientForTransport(createRouterTransport((router) => {
      router.service(AgentExecutionEvidenceService, {
        getDurableExecutionEvidence: () => {
          exactCalls += 1;
          throw new Error("unexpected exact lookup");
        },
        getRunDurableCheckpoint: () => {
          checkpointCalls += 1;
          return create(GetRunDurableCheckpointResponseSchema, {
            outcome: { case: "evidence", value: terminalEvidence() },
          });
        },
      });
    }));

    await expect(client.resolve({
      siteId: "site-a", sessionId: "session-a", launchId: "launch-a", runId,
    }, new AbortController().signal)).resolves.toMatchObject({ kind: "terminal_observed" });
    expect({ exactCalls, checkpointCalls }).toEqual({ exactCalls: 0, checkpointCalls: 1 });
  });

  it("returns not_found and fails closed on identity, digest, or typed-payload mismatch", async () => {
    const notFound = createAgentExecutionEvidenceClientForTransport(createRouterTransport((router) => {
      router.service(AgentExecutionEvidenceService, {
        getDurableExecutionEvidence: () => create(GetDurableExecutionEvidenceResponseSchema, {
          outcome: { case: "notFound", value: create(DurableExecutionEvidenceNotFoundSchema) },
        }),
      });
    }));
    await expect(notFound.resolve({
      siteId: "site-a", sessionId: "session-a", launchId: "launch-a", runId,
      gaDurableEventReceiptRef: evidenceRef,
    }, new AbortController().signal)).resolves.toEqual({ kind: "not_found" });

    for (const transport of [
      transportWithEvidence({ runId: "run-b" }),
      transportWithEvidence({ payloadSha256: "0".repeat(64) }),
      transportWithEvidence({ kind: DurableExecutionEvidenceKind.RUN_FAILED }),
    ]) {
      const client = createAgentExecutionEvidenceClientForTransport(transport);
      await expect(client.resolve({
        siteId: "site-a", sessionId: "session-a", launchId: "launch-a", runId,
        terminalOwnerEvidenceRef: evidenceRef,
      }, new AbortController().signal)).rejects.toEqual(
        new AgentExecutionEvidenceLookupError("invalid_response"),
      );
    }
  });

  it("does not expose upstream errors and preserves cancellation", async () => {
    const client = createAgentExecutionEvidenceClientForTransport(createRouterTransport((router) => {
      router.service(AgentExecutionEvidenceService, {
        getRunDurableCheckpoint: () => { throw new ConnectError("private", Code.Internal); },
      });
    }));
    const canceled = new AbortController();
    canceled.abort();

    await expect(client.resolve({ siteId: "s", sessionId: "x", launchId: "l", runId },
      new AbortController().signal)).rejects.toEqual(new AgentExecutionEvidenceLookupError("unavailable"));
    await expect(client.resolve({ siteId: "s", sessionId: "x", launchId: "l", runId },
      canceled.signal)).rejects.toEqual(new AgentExecutionEvidenceLookupError("canceled"));
  });

  it("builds a bounded HTTP/2 TLS 1.3 transport and rejects ambiguous endpoints", () => {
    const tls = {
      serverName: "kokoro-agent.internal",
      certificatePem: "-----BEGIN CERTIFICATE-----\nclient\n-----END CERTIFICATE-----",
      privateKeyPem: "-----BEGIN PRIVATE KEY-----\nclient\n-----END PRIVATE KEY-----",
      certificateAuthorityPem: "-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----",
    };
    expect(buildAgentExecutionEvidenceTransportOptions({
      baseUrl: "https://kokoro-agent.internal/", ...tls, timeoutMs: 4_000,
    })).toMatchObject({
      baseUrl: "https://kokoro-agent.internal",
      httpVersion: "2",
      useBinaryFormat: true,
      defaultTimeoutMs: 4_000,
      readMaxBytes: 72 * 1024,
      writeMaxBytes: 8 * 1024,
      acceptCompression: [],
      nodeOptions: { servername: tls.serverName, rejectUnauthorized: true, minVersion: "TLSv1.3" },
    });
    expect(() => buildAgentExecutionEvidenceTransportOptions({
      baseUrl: "http://kokoro-agent.internal", ...tls,
    })).toThrowError("AGENT_EXECUTION_EVIDENCE_MTLS_CONFIG_INVALID");
    expect(() => buildAgentExecutionEvidenceTransportOptions({
      baseUrl: "https://kokoro-agent.internal/path", ...tls,
    })).toThrowError("AGENT_EXECUTION_EVIDENCE_MTLS_CONFIG_INVALID");
  });
});
