import { createHash } from "node:crypto";
import { create, toBinary, type DescMessage, type Message } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { describe, expect, it, vi } from "vitest";
import {
  CommandDigestAlgorithm,
  CommandIdentitySchema,
} from "../../src/generated/proto/kokoro/common/v1/receipt_pb.js";
import {
  AdmissionOperation,
  FinalizeRunAuthorizationEffectSchema,
  FinalizeRunAuthorizationRequestSchema,
  GetCommandReceiptRequestSchema,
  OpaqueExecutionContextIntentSchema,
  PrepareRunEffectSchema,
  PrepareRunRequestSchema,
  PrepareRunResponseSchema,
  ReconcileRunAuthorizationEffectSchema,
  ReconcileRunAuthorizationRequestSchema,
  ReleaseRunAuthorizationEffectSchema,
  ReleaseRunAuthorizationRequestSchema,
  SafeAdmissionSnapshotSchema,
} from "../../src/generated/proto/kokoro/platform/admission/v1/admission_pb.js";
import type {
  AdmissionCommandJournal,
  AdmissionCommandKey,
  AdmissionJournalLookup,
  AdmissionOwnerAuthority,
  AdmissionReceiptLookup,
} from "../../src/modules/admission/application/admission-ports.js";
import { AdmissionApplicationService } from "../../src/modules/admission/application/admission-service.js";
import {
  GaRunRequestDraftFactory,
  type GaRunRequestDraftSealInput,
  type VerifiedGaRunRequestOwnerFacts,
} from "../../src/modules/admission/application/ga-run-request-draft-factory.js";

const now = new Date("2026-07-29T12:00:00.000Z");
const caller = { identity: "spiffe://kokoro/session", environment: "production", region: "us-east-1" };

const ownerFacts: VerifiedGaRunRequestOwnerFacts = {
  kind: "run.request",
  run_id: "run-1",
  thread_id: "thread-1",
  input: { message_id: "message-1", content: "hello" },
  runtime: {
    agent_catalog_ref: `agent-catalog:sha256:${"a".repeat(64)}`,
    agent_type: "general",
    model: {
      provider: "anthropic",
      name: "claude-sonnet",
      authorization_handle: `model-authorization:sha256:${"f".repeat(64)}`,
    },
    tools: [], skills: [], mcp_servers: [], subagents: [], backend: "state",
    permissions: {
      approval_tools: [], review_tools: [], subagent_create: "deny", filesystem: "read_only",
    },
  },
  context: { namespace: "opaque-namespace", session_id: "session-1" },
};

class MemoryJournal implements AdmissionCommandJournal {
  readonly records = new Map<string, { command: AdmissionCommandKey; response?: Uint8Array }>();

  async begin(command: AdmissionCommandKey) {
    const key = `${command.siteId}:${command.operation}:${command.idempotencyKey}`;
    const prior = this.records.get(key);
    if (prior !== undefined) {
      if (prior.command.commandId !== command.commandId || prior.command.requestDigest !== command.requestDigest) {
        throw new Error("ADMISSION_COMMAND_CONFLICT");
      }
      return prior.response === undefined
        ? { kind: "pending" as const, recordedAt: now.toISOString() }
        : { kind: "replay" as const, response: new Uint8Array(prior.response) };
    }
    this.records.set(key, { command });
    return { kind: "started" as const, leaseToken: "lease-1" };
  }

  async complete(command: AdmissionCommandKey, _leaseToken: string, response: Uint8Array) {
    const key = `${command.siteId}:${command.operation}:${command.idempotencyKey}`;
    const prior = this.records.get(key);
    if (prior === undefined) throw new Error("missing");
    prior.response = new Uint8Array(response);
    return new Uint8Array(response);
  }

  async lookup(query: AdmissionReceiptLookup): Promise<AdmissionJournalLookup> {
    const record = [...this.records.values()].find(({ command }) =>
      command.siteId === query.siteId && command.operation === query.operation &&
      command.commandId === query.commandId && command.requestDigest === query.requestDigest &&
      command.identity === query.identity);
    if (record === undefined) return { kind: "not_found" };
    if (record.response === undefined) {
      return { kind: "pending", idempotencyKey: record.command.idempotencyKey, recordedAt: now.toISOString() };
    }
    return { kind: "found", response: new Uint8Array(record.response) };
  }
}

function sealed(input: GaRunRequestDraftSealInput) {
  return {
    ciphertext: new Uint8Array(32).fill(7),
    encryptionAlgorithm: "HPKE-v1",
    keyRevisionRef: "kms:key:revision-7",
    audience: input.audience,
    expiresAt: "2026-07-29T12:01:00.000Z",
    plaintextSha256: input.plaintextSha256,
  };
}

function prepareRequest(commandId = "0198f279-7420-7a32-995f-7f4421eb6c42") {
  const effect = create(PrepareRunEffectSchema, {
    sessionAccessGrant: "grant-1",
    projectRef: "project-1",
    sessionId: "session-1",
    launchId: "launch-1",
    proposedRunId: "run-1",
    triggerMessageId: "message-1",
    triggerMessageContent: "hello",
    sessionProjectionAuthorizationHandle: `session-projection-authorization:${"c".repeat(64)}`,
    modelOptionRevisionRef: "model-option-revision-1",
    clientIntent: { locale: "en-US" },
    executionContext: create(OpaqueExecutionContextIntentSchema, {
      mode: { case: "root", value: true },
    }),
  });
  const requestDigest = createHash("sha256")
    .update(effect.$typeName).update("\0")
    .update(toBinary(PrepareRunEffectSchema, effect, { writeUnknownFields: false }))
    .digest("hex");
  return create(PrepareRunRequestSchema, {
    siteId: "site-1",
    command: create(CommandIdentitySchema, {
      commandId,
      idempotencyKey: "launch-1:prepare",
      digestAlgorithm: CommandDigestAlgorithm.SHA256_PROTOBUF_V1,
      requestDigest,
    }),
    effect,
  });
}

function wireCommand<Schema extends DescMessage>(
  schema: Schema,
  effect: ReturnType<typeof create<Schema>>,
  idempotencyKey: string,
) {
  return create(CommandIdentitySchema, {
    commandId: `0198f279-7420-7a32-995f-${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 12)}`,
    idempotencyKey,
    digestAlgorithm: CommandDigestAlgorithm.SHA256_PROTOBUF_V1,
    requestDigest: createHash("sha256")
      .update((effect as Message).$typeName).update("\0")
      .update(toBinary(schema, effect, { writeUnknownFields: false }))
      .digest("hex"),
  });
}

function authority(authorizationExpiresAt = "2026-07-29T12:02:00.000Z"): AdmissionOwnerAuthority {
  return {
    prepareRun: vi.fn(async () => ({
      kind: "accepted" as const,
      ownerFacts,
      prerequisiteRefs: [],
      prepared: {
        manifestRef: "manifest-1",
        manifestDigest: "b".repeat(64),
        sessionExecutionBindingRef: "binding-1",
        capabilitySnapshotRef: "capability-snapshot-1",
        configurationRevisionId: "configuration-1",
        executionBudgetRootRef: "budget-1",
        rootHoldRef: "hold-1",
        authorizationSegmentRef: "segment-1",
        segmentVersion: 1n,
        expiresAt: timestampFromDate(new Date(authorizationExpiresAt)),
        safeAdmissionSnapshot: create(SafeAdmissionSnapshotSchema, {
          modelLabel: "Claude Sonnet",
          policyDecisionRef: "policy-1",
          capabilities: [],
        }),
      },
    })),
    finalizeRunAuthorization: vi.fn(async () => ({ kind: "pending" as const, pending: {} })),
    releaseRunAuthorization: vi.fn(async () => ({ kind: "pending" as const, pending: {} })),
    reconcileRunAuthorization: vi.fn(async () => ({ kind: "pending" as const, pending: {} })),
  };
}

function service(owner = authority(), journal = new MemoryJournal()) {
  return {
    owner,
    journal,
    service: new AdmissionApplicationService({
      authority: owner,
      journal,
      gaRunRequestDraftFactory: new GaRunRequestDraftFactory({
        sealer: { seal: async (input) => sealed(input) },
        expectedAudience: "kokoro-session-dispatch",
        clock: () => now,
      }),
      clock: () => now,
    }),
  };
}

describe("Admission application provider", () => {
  it("resolves owner facts, seals the complete context-bearing run request and replays exactly once", async () => {
    const fixture = service();
    const request = prepareRequest();

    const first = await fixture.service.prepareRun(request, caller);
    const replay = await fixture.service.prepareRun(request, caller);

    expect(first.result.case).toBe("accepted");
    expect(first.result.case === "accepted" && first.result.value.prepared?.runRequestMaterial).toMatchObject({
      audience: "kokoro-session-dispatch",
      encryptionAlgorithm: "HPKE-v1",
    });
    // Duplicate delivery must return the exact durable typed outcome.
    expect(toBinary(PrepareRunResponseSchema, replay)).toEqual(
      toBinary(PrepareRunResponseSchema, first),
    );
    expect(fixture.owner.prepareRun).toHaveBeenCalledOnce();
    expect(fixture.owner.prepareRun).toHaveBeenCalledWith(expect.objectContaining({
      caller,
      siteId: "site-1",
      effect: expect.objectContaining({
        ...request.effect,
        sessionProjectionAuthorizationHandle:
          `session-projection-authorization:${"c".repeat(64)}`,
      }),
    }));
  });

  it("recovers the typed outcome with a top-level receipt identical to the nested receipt", async () => {
    const fixture = service();
    const request = prepareRequest();
    const prepared = await fixture.service.prepareRun(request, caller);
    const recovered = await fixture.service.getCommandReceipt(create(GetCommandReceiptRequestSchema, {
      siteId: "site-1",
      operation: AdmissionOperation.PREPARE_RUN,
      commandId: request.command!.commandId,
      digestAlgorithm: CommandDigestAlgorithm.SHA256_PROTOBUF_V1,
      requestDigest: request.command!.requestDigest,
    }), caller);

    expect(recovered.result.case).toBe("prepareRun");
    expect(recovered.receipt).toEqual(prepared.receipt);
    expect(recovered.result.case === "prepareRun" && recovered.result.value.receipt).toEqual(recovered.receipt);
  });

  it("rejects a forged effect digest before touching the journal or owner authority", async () => {
    const fixture = service();
    const request = prepareRequest();
    request.command!.requestDigest = "f".repeat(64);

    await expect(fixture.service.prepareRun(request, caller)).rejects.toThrow(
      "ADMISSION_COMMAND_DIGEST_MISMATCH",
    );
    expect(fixture.journal.records.size).toBe(0);
    expect(fixture.owner.prepareRun).not.toHaveBeenCalled();
  });

  it("never issues encrypted run material that outlives the authorization", async () => {
    const fixture = service(authority("2026-07-29T12:00:30.000Z"));

    const response = await fixture.service.prepareRun(prepareRequest(), caller);

    expect(response.result.case).toBe("outcomeUnknown");
    expect(response.receipt?.state).toBe(4);
  });

  it("never seals owner facts whose content differs from the authenticated Session effect", async () => {
    const owner = authority();
    owner.prepareRun = vi.fn(async () => ({
      kind: "accepted" as const,
      ownerFacts: { ...ownerFacts, input: { message_id: "message-1", content: "different" } },
      prerequisiteRefs: [],
      prepared: {
        manifestRef: "manifest-1",
        manifestDigest: "b".repeat(64),
        sessionExecutionBindingRef: "binding-1",
        capabilitySnapshotRef: "capability-snapshot-1",
        configurationRevisionId: "configuration-1",
        executionBudgetRootRef: "budget-1",
        rootHoldRef: "hold-1",
        authorizationSegmentRef: "segment-1",
        segmentVersion: 1n,
        expiresAt: timestampFromDate(new Date("2026-07-29T12:02:00.000Z")),
        safeAdmissionSnapshot: create(SafeAdmissionSnapshotSchema, {
          modelLabel: "Claude Sonnet",
          policyDecisionRef: "policy-1",
          capabilities: [],
        }),
      },
    }));
    const fixture = service(owner);

    const response = await fixture.service.prepareRun(prepareRequest(), caller);

    expect(response.result.case).toBe("outcomeUnknown");
  });

  it("enforces versioned commit, release and reconciliation outcomes on all effect handlers", async () => {
    const owner = authority();
    owner.finalizeRunAuthorization = vi.fn(async ({ effect }) => ({
      kind: "committed" as const,
      committed: {
        authorizationSegmentRef: effect.authorizationSegmentRef,
        segmentVersion: effect.expectedSegmentVersion + 1n,
        committedAt: timestampFromDate(now),
      },
    }));
    owner.releaseRunAuthorization = vi.fn(async ({ effect }) => ({
      kind: "released" as const,
      released: {
        authorizationSegmentRef: effect.authorizationSegmentRef,
        segmentVersion: effect.expectedSegmentVersion + 1n,
        releasedAt: timestampFromDate(now),
      },
    }));
    owner.reconcileRunAuthorization = vi.fn(async ({ effect }) => ({
      kind: "settled" as const,
      result: {
        authorizationSegmentRef: effect.authorizationSegmentRef,
        segmentVersion: effect.expectedSegmentVersion + 1n,
        observedAt: timestampFromDate(now),
      },
    }));
    const fixture = service(owner);
    const finalizeEffect = create(FinalizeRunAuthorizationEffectSchema, {
      manifestRef: "manifest-1", manifestDigest: "b".repeat(64),
      authorizationSegmentRef: "segment-1", expectedSegmentVersion: 1n,
      launchId: "launch-1", sessionIntentReceiptRef: "intent-receipt-1",
    });
    const releaseEffect = create(ReleaseRunAuthorizationEffectSchema, {
      manifestRef: "manifest-1", authorizationSegmentRef: "segment-1",
      expectedSegmentVersion: 1n, reasonCode: "dispatch_failed",
      noDispatchEvidenceRef: "no-dispatch-1",
    });
    const reconcileEffect = create(ReconcileRunAuthorizationEffectSchema, {
      manifestRef: "manifest-1", authorizationSegmentRef: "segment-1",
      expectedSegmentVersion: 1n, terminalOwnerEvidenceRef: "terminal-1",
    });

    const finalized = await fixture.service.finalizeRunAuthorization(
      create(FinalizeRunAuthorizationRequestSchema, {
        siteId: "site-1", effect: finalizeEffect,
        command: wireCommand(FinalizeRunAuthorizationEffectSchema, finalizeEffect, "finalize-1"),
      }), caller,
    );
    const released = await fixture.service.releaseRunAuthorization(
      create(ReleaseRunAuthorizationRequestSchema, {
        siteId: "site-1", effect: releaseEffect,
        command: wireCommand(ReleaseRunAuthorizationEffectSchema, releaseEffect, "release-1"),
      }), caller,
    );
    const reconciled = await fixture.service.reconcileRunAuthorization(
      create(ReconcileRunAuthorizationRequestSchema, {
        siteId: "site-1", effect: reconcileEffect,
        command: wireCommand(ReconcileRunAuthorizationEffectSchema, reconcileEffect, "reconcile-1"),
      }), caller,
    );

    expect(finalized.result.case).toBe("committed");
    expect(released.result.case).toBe("released");
    expect(reconciled.result.case).toBe("settled");
  });
});
