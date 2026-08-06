import { randomBytes } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import type { HandlerContext } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import {
  RecoverMediaOperationByCommandRequestSchema,
} from "../../src/generated/proto/kokoro/platform/media/v1/media_runtime_pb.js";
import { PostgresMediaRuntimeQueryRepository } from
  "../../src/modules/media/infrastructure/postgres/media-runtime-query-repository.js";
import { createMediaRuntimeConnectService } from
  "../../src/modules/media/interfaces/connect/media-runtime-service.js";

const access = "media_access_v1." + "a".repeat(43);
const commandRef = "agent-media-command:one";
const fingerprint = "a".repeat(64);

describe("Agent Media recovery", () => {
  it("distinguishes processing from not-found and committed command state", async () => {
    const database = {
      recoverAgentMediaCommand: vi.fn(),
      getAgentMediaOperation: vi.fn(),
    };
    const query = new PostgresMediaRuntimeQueryRepository({ database, handleKey: randomBytes(32) });
    database.recoverAgentMediaCommand.mockResolvedValueOnce([]);
    await expect(query.recoverByCommand({ mediaAccessHandle: access, commandRef }))
      .resolves.toEqual({ kind: "not_found" });
    database.recoverAgentMediaCommand.mockResolvedValueOnce([{
      commandState: "processing", callerRequestFingerprint: fingerprint, operationRef: null,
      receiptVersion: 1n, receiptRecordedAt: "2026-07-31T11:59:59.000Z",
      receiptKind: "create_agent_image_operation", receiptOutcome: "submit_outcome_unknown",
    }]);
    await expect(query.recoverByCommand({ mediaAccessHandle: access, commandRef }))
      .resolves.toEqual({ kind: "processing", callerRequestFingerprint: fingerprint,
        receipt: { version: 1n, recordedAt: "2026-07-31T11:59:59.000Z",
          commandKind: "create_agent_image_operation", outcome: "submit_outcome_unknown" } });
    database.recoverAgentMediaCommand.mockResolvedValueOnce([{
      commandState: "committed", callerRequestFingerprint: fingerprint, operationRef: "media-operation:one",
      receiptVersion: 2n, receiptRecordedAt: "2026-07-31T12:00:00.000Z",
      receiptKind: "create_agent_image_operation", receiptOutcome: "submit_accepted",
    }]);
    await expect(query.recoverByCommand({ mediaAccessHandle: access, commandRef }))
      .resolves.toEqual({ kind: "committed", callerRequestFingerprint: fingerprint,
        operationRef: "media-operation:one", receipt: { version: 2n,
          recordedAt: "2026-07-31T12:00:00.000Z",
          commandKind: "create_agent_image_operation", outcome: "submit_accepted" } });
  });

  it("returns rejected-without-view for not-found and unknown-without-view for processing", async () => {
    const query = { recoverByCommand: vi.fn(), get: vi.fn() };
    const service = createMediaRuntimeConnectService({
      application: { submitAgentImage: vi.fn() }, query,
      caller: { resolve: () => ({ identity: "spiffe://kokoro/ga" }) },
      agentCallerIdentity: "spiffe://kokoro/ga", clock: () => new Date("2026-07-31T12:00:00.000Z"),
    });
    const request = create(RecoverMediaOperationByCommandRequestSchema, {
      mediaAccessHandle: access, mediaCommandRef: commandRef,
    });
    const context = { signal: new AbortController().signal } as HandlerContext;
    query.recoverByCommand.mockResolvedValueOnce({ kind: "not_found" });
    const missing = await service.recoverMediaOperationByCommand(request, context);
    expect(missing.receipt?.outcome?.case).toBe("submitRejected");
    expect(missing.operation).toBeUndefined();
    query.recoverByCommand.mockResolvedValueOnce({ kind: "processing",
      callerRequestFingerprint: fingerprint, receipt: { version: 1n,
        recordedAt: "2026-07-31T11:59:59.000Z",
        commandKind: "create_agent_image_operation", outcome: "submit_outcome_unknown" } });
    const processing = await service.recoverMediaOperationByCommand(request, context);
    expect(processing.receipt?.outcome?.case).toBe("submitOutcomeUnknown");
    expect(processing.operation).toBeUndefined();
    expect(query.get).not.toHaveBeenCalled();
  });

  it("replays the exact durable accepted receipt instead of recomputing time or version", async () => {
    const query = { recoverByCommand: vi.fn(), get: vi.fn() };
    const service = createMediaRuntimeConnectService({
      application: { submitAgentImage: vi.fn() }, query,
      caller: { resolve: () => ({ identity: "spiffe://kokoro/ga" }) },
      agentCallerIdentity: "spiffe://kokoro/ga", clock: () => new Date("2026-08-01T12:00:00.000Z"),
    });
    query.recoverByCommand.mockResolvedValueOnce({
      kind: "committed", callerRequestFingerprint: fingerprint, operationRef: "media-operation:one",
      receipt: { version: 2n, recordedAt: "2026-07-31T12:00:00.000Z",
        commandKind: "create_agent_image_operation", outcome: "submit_accepted" },
    });
    query.get.mockResolvedValueOnce({ mediaOperationHandle: "media_handle_v1.operation",
      operationRef: "media-operation:one", ownerVersion: 1n, state: "queued",
      observedAt: "2026-07-31T12:00:00.000Z", candidates: [] });
    const response = await service.recoverMediaOperationByCommand(
      create(RecoverMediaOperationByCommandRequestSchema, {
        mediaAccessHandle: access, mediaCommandRef: commandRef,
      }),
      { signal: new AbortController().signal } as HandlerContext,
    );
    expect(response.receipt?.outcome?.value?.receiptVersion).toBe(2n);
    expect(response.receipt?.outcome?.value?.recordedAt?.seconds).toBe(1_785_499_200n);
  });
});
