import { create } from "@bufbuild/protobuf";
import { describe, expect, it, vi } from "vitest";
import {
  AdmissionRetryClass,
  ClientRunIntentSchema,
  FinalizeRunAuthorizationEffectSchema,
  OpaqueExecutionContextIntentSchema,
  PrepareRunEffectSchema,
  ReconcileRunAuthorizationEffectSchema,
  ReleaseRunAuthorizationEffectSchema,
} from "../src/generated/proto/kokoro/platform/admission/v1/admission_pb.js";
import {
  PlatformAdmissionOwnerAuthority,
  type PlatformAdmissionOwnerPorts,
} from "../src/modules/admission/application/platform-admission-owner-authority.js";
import {
  AdmissionOwnerNoEffectError,
  type AdmissionAuthorityCommand,
} from "../src/modules/admission/application/admission-ports.js";
import { createPlatformAdmissionOwnerAuthority } from "../src/process/admission-composition.js";
import {
  issuePlatformTransaction,
  revokePlatformTransaction,
} from "../src/shared/unit-of-work/platform-transaction.js";
import type { PlatformTransaction } from "../src/shared/unit-of-work/index.js";

const now = new Date("2026-07-29T12:00:00.000Z");
const mediaProjectionRecoveryKey = new Uint8Array(32).fill(9);
const caller = Object.freeze({
  identity: "spiffe://kokoro/session",
  environment: "production",
  region: "us-east-1",
});

function prepareEffect() {
  return create(PrepareRunEffectSchema, {
    sessionAccessGrant: "grant-1",
    projectRef: "project-1",
    sessionId: "session-1",
    launchId: "launch-1",
    proposedRunId: "run-1",
    triggerMessageId: "message-1",
    triggerMessageContent: "hello",
    modelOptionRevisionRef: "model-option-1",
    clientIntent: create(ClientRunIntentSchema, { effort: "medium", locale: "en-US" }),
    executionContext: create(OpaqueExecutionContextIntentSchema, {
      mode: { case: "root", value: true },
    }),
  });
}

function finalizeEffect() {
  return create(FinalizeRunAuthorizationEffectSchema, {
    manifestRef: "manifest-1",
    manifestDigest: "a".repeat(64),
    authorizationSegmentRef: "segment-1",
    expectedSegmentVersion: 1n,
    launchId: "launch-1",
    sessionIntentReceiptRef: "intent-receipt-1",
  });
}

function releaseEffect() {
  return create(ReleaseRunAuthorizationEffectSchema, {
    manifestRef: "manifest-1",
    authorizationSegmentRef: "segment-1",
    expectedSegmentVersion: 1n,
    reasonCode: "DISPATCH_PAYLOAD_INVALID",
    noDispatchEvidenceRef: `session-dispatch-evidence:v1:${"b".repeat(64)}`,
  });
}

function reconcileEffect() {
  return create(ReconcileRunAuthorizationEffectSchema, {
    manifestRef: "manifest-1",
    authorizationSegmentRef: "segment-1",
    expectedSegmentVersion: 1n,
    terminalOwnerEvidenceRef: "terminal-evidence-1",
  });
}

function outcomeUnknownReconcileEffect() {
  return create(ReconcileRunAuthorizationEffectSchema, {
    manifestRef: "manifest-1",
    authorizationSegmentRef: "segment-1",
    expectedSegmentVersion: 1n,
    sessionDispatchReceiptRef: "dispatch-unknown-1",
  });
}

function terminalExecutionEvidence() {
  return {
    kind: "terminal_observed" as const,
    terminalEvidenceRef: "terminal-evidence-1",
    terminalEvidenceDigest: "f".repeat(64),
    terminalOutcome: "completed" as const,
    safeStatusRef: "terminal-evidence-1",
  };
}

function settledReconciliationBudget() {
  return {
    kind: "settled" as const,
    segmentVersion: 2n,
    settlement: {
      settlementRef: "settlement-1",
      closureRef: "closure-1",
      ratedAmount: "1",
      currencyOrCreditUnit: "credit_micros",
      ratingSnapshotRef: "rating-snapshot-1",
      usageEvidenceRefs: ["usage-evidence-1"],
    },
  };
}

function outcomeUnknownDispatchEvidence() {
  return {
    kind: "found" as const,
    evidence: {
      evidenceRef: "dispatch-unknown-1",
      evidenceVersion: "1" as const,
      kind: "outcome_unknown" as const,
      siteId: "site-1",
      sessionId: "session-1",
      dispatchId: "dispatch-1",
      launchId: "launch-1",
      runId: "run-1",
      authorizationSegmentRef: "segment-1",
      authorizationSegmentVersion: "1",
      leaseGeneration: "1",
      payloadSha256: "c".repeat(64),
      recordedAt: now.toISOString(),
    },
  };
}

function ports(events: string[] = []): PlatformAdmissionOwnerPorts {
  const transaction = Object.freeze({}) as PlatformTransaction;
  let transactionActive = false;
  const record = Object.freeze({
    siteId: "site-1",
    manifestRef: "manifest-1",
    manifestDigest: "a".repeat(64),
    sessionId: "session-1",
    launchId: "launch-1",
    runId: "run-1",
    rootHoldRef: "hold-1",
    authorizationSegmentRef: "segment-1",
    segmentVersion: 1n,
    state: "reserved" as const,
    expiresAt: "2026-07-29T12:04:00.000Z",
  });
  return {
    unitOfWork: {
      execute: async (_command, work) => {
        events.push("tx.begin");
        transactionActive = true;
        try {
          return await work(transaction);
        } finally {
          transactionActive = false;
          events.push("tx.end");
        }
      },
    },
    session: {
      resolve: vi.fn(async () => {
        expect(transactionActive).toBe(false);
        events.push("session");
        return {
          kind: "resolved" as const,
          value: { threadId: "session-1" },
        };
      }),
      verifyFinalizeReceipts: vi.fn(async () => {
        expect(transactionActive).toBe(false);
        events.push("session.finalize-rpc");
        return { kind: "verified" as const };
      }),
    },
    sessionGrant: { resolve: vi.fn(async () => {
      events.push("session-grant");
      return {
        kind: "resolved" as const,
        value: { subjectRef: "subject-1", subjectGeneration: 1n },
      };
    }) },
    executionBinding: { resolve: vi.fn(async () => {
      events.push("execution-binding");
      return {
        kind: "resolved" as const,
        value: { namespace: "opaque-namespace", sessionExecutionBindingRef: "binding-1" },
      };
    }) },
    mediaProjection: { issueReservation: vi.fn(async () => {
      events.push("media-projection.rpc");
      return { kind: "resolved" as const,
        value: { mediaProjectionReservationHandle: "projection-reservation:" + "p".repeat(32),
          expiresAt: "2026-07-29T12:04:00.000Z", reservationReceiptRef: "reservation-receipt:one" } };
    }) },
    mediaAccess: { reserve: vi.fn(async () => {
      events.push("media-access.reserve");
      return { kind: "resolved" as const,
        value: { mediaAccessHandle: "media-access:" + "m".repeat(32) } };
    }) },
    site: { resolve: vi.fn(async () => {
      events.push("site");
      return {
        kind: "resolved" as const,
        value: {
          configurationRevisionId: "configuration-1",
          policyDecisionRef: "policy-1",
        },
      };
    }) },
    runtimePolicy: { resolve: vi.fn(async () => {
      events.push("runtime-policy");
      return {
        kind: "resolved" as const,
        value: {
          backend: "state" as const,
          permissions: {
            approval_tools: [], review_tools: [], subagent_create: "deny" as const,
            filesystem: "read_only" as const,
          },
        },
      };
    }) },
    model: { resolve: vi.fn(async () => {
      events.push("model");
      return {
        kind: "resolved" as const,
        value: {
          provider: "direct",
          name: "chat-primary",
          route: {
            adapterKind: "direct" as const,
            gatewayModel: "chat-primary",
            providerModel: "claude-sonnet",
          },
          effort: "medium",
          modelLabel: "Claude Sonnet",
        },
      };
    }) },
    capability: { resolve: vi.fn(async () => {
      events.push("capability");
      return {
        kind: "resolved" as const,
        value: {
          capabilitySnapshotRef: "capability-1",
          agentCatalogRef: `agent-catalog:sha256:${"a".repeat(64)}`,
          tools: ["read_file"], skills: [], mcpServers: [], subagents: [],
          safeCapabilities: [{ kind: "skill" as const, label: "Files" }],
          prerequisiteRefs: [],
        },
      };
    }) },
    assets: { validate: vi.fn(async () => {
      events.push("assets");
      return { kind: "resolved" as const, value: undefined };
    }) },
    budget: {
      reserveRoot: vi.fn(async () => {
        events.push("budget.reserve");
        return {
          kind: "resolved" as const,
          value: {
            executionBudgetRootRef: "budget-1",
            rootHoldRef: "hold-1",
            authorizationSegmentRef: "segment-1",
            segmentVersion: 1n,
            expiresAt: "2026-07-29T12:04:00.000Z",
            estimatedCostDisplay: "≤ 10 credits",
          },
        };
      }),
      commitRoot: vi.fn(async () => ({ segmentVersion: 2n })),
      releaseRoot: vi.fn(async () => { events.push("budget.release"); return { segmentVersion: 2n } }),
      reconcileRoot: vi.fn(async () => ({ kind: "reconciliation_required" as const,
        segmentVersion: 2n })),
    },
    lifecycle: {
      prepare: vi.fn(async (_transaction, input) => {
        events.push("lifecycle.prepare");
        return {
          ...record,
          manifestRef: input.manifestRef,
          manifestDigest: input.manifestDigest,
          authorizationSegmentRef: input.authorizationSegmentRef,
          segmentVersion: input.segmentVersion,
          expiresAt: input.expiresAt,
        };
      }),
      read: vi.fn(async () => { events.push("lifecycle.read"); return record }),
      lock: vi.fn(async () => { events.push("lifecycle.lock"); return record }),
      commit: vi.fn(async () => record),
      expire: vi.fn(async () => ({ ...record, state: "expired" as const, segmentVersion: 2n })),
      release: vi.fn(async () => {
        events.push("lifecycle.release");
        return { ...record, state: "released" as const, segmentVersion: 2n };
      }),
      requireReconciliation: vi.fn(async () => ({
        ...record, state: "reconciliation_required" as const, segmentVersion: 2n,
      })),
      settle: vi.fn(async () => ({ ...record, state: "settled" as const, segmentVersion: 2n })),
    },
    dispatchEvidence: {
      get: vi.fn(async () => {
        expect(transactionActive).toBe(false);
        events.push("dispatch.rpc");
        return {
          kind: "found" as const,
          evidence: {
            evidenceRef: `session-dispatch-evidence:v1:${"b".repeat(64)}`,
            evidenceVersion: "1" as const,
            kind: "no_dispatch" as const,
            siteId: "site-1",
            sessionId: "session-1",
            dispatchId: "dispatch-1",
            launchId: "launch-1",
            runId: "run-1",
            authorizationSegmentRef: "segment-1",
            authorizationSegmentVersion: "1",
            leaseGeneration: "1",
            payloadSha256: "c".repeat(64),
            recordedAt: now.toISOString(),
          },
        };
      }),
    },
    executionEvidence: {
      resolve: vi.fn(async () => ({ kind: "not_found" as const })),
    },
  };
}

describe("Platform Admission owner authority", () => {
  it("lets production construct the authority only from exact owner ports and the Platform UoW", async () => {
    const dependencies = ports();
    vi.mocked(dependencies.budget.reserveRoot).mockResolvedValue({
      kind: "denied",
      denial: { code: "TEST_BUDGET_DENIED", retryClass: AdmissionRetryClass.NEVER },
    });
    const scoped: unknown[][] = [];
    const sql = {
      query: vi.fn(async (_statement: string, values: readonly unknown[] = []) => {
        scoped.push([...values]);
        return [];
      }),
      execute: vi.fn(async () => 0),
    };
    const internalTransaction = vi.fn(async (_operation, work) => {
      const lease = issuePlatformTransaction(sql);
      try { return await work(lease.transaction); } finally { revokePlatformTransaction(lease); }
    });
    const {
      unitOfWork: _unitOfWork,
      lifecycle: _lifecycle,
      site: _site,
      model: _model,
      sessionGrant: _sessionGrant,
      executionBinding: _executionBinding,
      mediaAccess: _mediaAccess,
      ...ownerPorts
    } = dependencies;
    const authority = createPlatformAdmissionOwnerAuthority({
      database: { internalTransaction },
      ownerPorts,
      mediaAccessKey: new Uint8Array(32).fill(7),
      clock: () => now,
    });

    await authority.prepareRun({
      caller,
      siteId: "site-1",
      commandId: "command-1",
      requestDigest: "d".repeat(64),
      effect: prepareEffect(),
    });

    expect(internalTransaction).toHaveBeenCalledWith("admission.command", expect.any(Function));
    expect(scoped).toContainEqual(["site-1", "spiffe://kokoro/session"]);
  });

  it("fails production startup when any required owner adapter is absent", () => {
    const dependencies = ports();
    const {
      unitOfWork: _unitOfWork,
      lifecycle: _lifecycle,
      session: _session,
      ...ownerPorts
    } = dependencies;

    expect(() => createPlatformAdmissionOwnerAuthority({
      database: { internalTransaction: vi.fn() },
      mediaAccessKey: new Uint8Array(32).fill(7),
      ownerPorts: ownerPorts as unknown as Omit<
        PlatformAdmissionOwnerPorts,
        "unitOfWork" | "lifecycle" | "site" | "model" | "runtimePolicy" | "capability" |
        "assets" | "budget" | "sessionGrant" | "executionBinding"
      >,
      clock: () => now,
    })).toThrowError("PLATFORM_ADMISSION_OWNER_PORTS_REQUIRED");
  });

  it("resolves every Platform owner in one local UoW and freezes one complete GA request", async () => {
    const events: string[] = [];
    const dependencies = ports(events);
    const authority = new PlatformAdmissionOwnerAuthority({ ports: dependencies,
      mediaProjectionRecoveryKey, clock: () => now });

    const decision = await authority.prepareRun({
      caller,
      siteId: "site-1",
      commandId: "command-1",
      requestDigest: "d".repeat(64),
      effect: prepareEffect(),
    });

    expect(decision.kind).toBe("accepted");
    if (decision.kind !== "accepted") throw new Error("unexpected decision");
    expect(dependencies.session.resolve).toHaveBeenCalledWith({
      siteId: "site-1", projectRef: "project-1", sessionId: "session-1", launchId: "launch-1",
      runId: "run-1", triggerMessageId: "message-1", commandId: "command-1",
      requestDigest: "d".repeat(64),
    }, expect.any(AbortSignal));
    expect(decision.ownerFacts).toEqual({
      kind: "run.request",
      run_id: "run-1",
      thread_id: "session-1",
      input: { message_id: "message-1", content: "hello" },
      runtime: {
        agent_catalog_ref: `agent-catalog:sha256:${"a".repeat(64)}`,
        agent_type: "general",
        model: {
          provider: "direct",
          name: "chat-primary",
          effort: "medium",
          authorization_handle: expect.stringMatching(/^model-authorization:sha256:[0-9a-f]{64}$/u),
        },
        tools: ["read_file"], skills: [], mcp_servers: [], subagents: [], backend: "state",
        permissions: {
          approval_tools: [], review_tools: [], subagent_create: "deny", filesystem: "read_only",
        },
      },
      context: { namespace: "opaque-namespace", session_id: "session-1" },
    });
    expect(decision.prepared).toMatchObject({
      manifestRef: expect.stringMatching(/^execution-manifest:sha256:[0-9a-f]{64}$/u),
      sessionExecutionBindingRef: "binding-1",
      capabilitySnapshotRef: "capability-1",
      configurationRevisionId: "configuration-1",
      executionBudgetRootRef: "budget-1",
      rootHoldRef: "hold-1",
      authorizationSegmentRef: "segment-1",
      segmentVersion: 1n,
    });
    const budgetInput = vi.mocked(dependencies.budget.reserveRoot).mock.calls[0]?.[1] as
      | Readonly<{ manifestRef?: string; manifestDigest?: string; maximumExpiresAt?: string }>
      | undefined;
    const lifecycleInput = vi.mocked(dependencies.lifecycle.prepare).mock.calls[0]?.[1] as
      | Readonly<{
        manifestRef?: string;
        authorizationSegmentRef?: string;
        segmentVersion?: bigint;
        expiresAt?: string;
        modelRoute?: {
          adapterKind: string;
          gatewayModel: string;
          providerModel: string;
        };
      }>
      | undefined;
    expect(budgetInput?.manifestRef).toBe(`execution-manifest:sha256:${budgetInput?.manifestDigest}`);
    expect(budgetInput?.maximumExpiresAt).toBe("2026-07-29T12:05:00.000Z");
    expect(lifecycleInput).toMatchObject({
      manifestRef: budgetInput?.manifestRef,
      authorizationSegmentRef: "segment-1",
      segmentVersion: 1n,
      expiresAt: "2026-07-29T12:04:00.000Z",
      modelRoute: {
        adapterKind: "direct",
        gatewayModel: "chat-primary",
        providerModel: "claude-sonnet",
      },
    });
    expect(events).toEqual([
      "session", "tx.begin", "site", "session-grant", "runtime-policy", "model", "capability",
      "assets", "execution-binding", "budget.reserve", "lifecycle.prepare", "tx.end",
    ]);
  });

  it("includes the private provider model in the manifest digest without exposing it to Agent", async () => {
    const firstPorts = ports();
    const secondPorts = ports();
    vi.mocked(secondPorts.model.resolve).mockResolvedValue({
      kind: "resolved",
      value: {
        provider: "direct",
        name: "chat-primary",
        route: {
          adapterKind: "direct",
          gatewayModel: "chat-primary",
          providerModel: "claude-sonnet-next",
        },
        effort: "medium",
        modelLabel: "Claude Sonnet",
      },
    });
    const first = await new PlatformAdmissionOwnerAuthority({ ports: firstPorts,
      mediaProjectionRecoveryKey, clock: () => now }).prepareRun({
      caller, siteId: "site-1", commandId: "command-1",
      requestDigest: "d".repeat(64), effect: prepareEffect(),
    });
    const second = await new PlatformAdmissionOwnerAuthority({ ports: secondPorts,
      mediaProjectionRecoveryKey, clock: () => now }).prepareRun({
      caller, siteId: "site-1", commandId: "command-1",
      requestDigest: "d".repeat(64), effect: prepareEffect(),
    });
    if (first.kind !== "accepted" || second.kind !== "accepted") {
      throw new Error("unexpected decision");
    }

    expect(first.ownerFacts).toEqual(second.ownerFacts);
    expect(JSON.stringify(first.ownerFacts)).not.toMatch(/claude-sonnet/u);
    expect(first.prepared.manifestDigest).not.toBe(second.prepared.manifestDigest);
    expect(vi.mocked(secondPorts.lifecycle.prepare).mock.calls[0]?.[1].modelRoute)
      .toEqual({
        adapterKind: "direct",
        gatewayModel: "chat-primary",
        providerModel: "claude-sonnet-next",
      });
  });

  it("issues Session projection outside local transactions and seals both opaque Media handles into runtime", async () => {
    const events: string[] = [];
    const dependencies = ports(events);
    vi.mocked(dependencies.session.resolve).mockImplementation(async () => {
      events.push("session");
      return { kind: "resolved", value: { threadId: "session-1", assistantMessageId: "assistant-1" } };
    });
    const authority = new PlatformAdmissionOwnerAuthority({ ports: dependencies,
      mediaProjectionRecoveryKey, clock: () => now });
    const effect = prepareEffect();
    effect.sessionProjectionAuthorizationHandle = "session-projection-authorization:" + "s".repeat(32);

    const decision = await authority.prepareRun({ caller, siteId: "site-1", commandId: "command-media",
      requestDigest: "f".repeat(64), effect });

    expect(decision.kind).toBe("accepted");
    if (decision.kind !== "accepted") throw new Error("unexpected decision");
    expect(decision.ownerFacts.runtime.media).toEqual({
      media_access_handle: "media-access:" + "m".repeat(32),
      media_projection_reservation_handle: "projection-reservation:" + "p".repeat(32),
    });
    expect(dependencies.mediaProjection.issueReservation).toHaveBeenCalledWith(expect.objectContaining({
      sessionProjectionAuthorizationHandle: effect.sessionProjectionAuthorizationHandle,
      sessionId: "session-1", runId: "run-1", assistantMessageId: "assistant-1",
      subjectGeneration: 1n, maximumSlots: 16,
      projectionCommandRef: expect.stringMatching(/^media-projection-command:sha256:/u),
      projectionCommandRecoveryCapability: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
    }), expect.any(AbortSignal));
    expect(events).toEqual([
      "session",
      "tx.begin", "site", "session-grant", "tx.end",
      "media-projection.rpc",
      "tx.begin", "site", "session-grant", "runtime-policy", "model", "capability",
      "assets", "execution-binding", "media-access.reserve", "budget.reserve", "lifecycle.prepare", "tx.end",
    ]);

    const firstRecoveryCapability = vi.mocked(dependencies.mediaProjection.issueReservation)
      .mock.calls[0]?.[0].projectionCommandRecoveryCapability;
    await authority.prepareRun({ caller, siteId: "site-1", commandId: "command-media",
      requestDigest: "f".repeat(64), effect });
    expect(vi.mocked(dependencies.mediaProjection.issueReservation)
      .mock.calls[1]?.[0].projectionCommandRecoveryCapability).toBe(firstRecoveryCapability);
  });

  it("verifies Session finalize receipts outside the DB transaction before the local CAS", async () => {
    const events: string[] = [];
    const dependencies = ports(events);
    vi.mocked(dependencies.budget.commitRoot).mockImplementation(async () => {
      events.push("budget.commit");
      return { segmentVersion: 2n };
    });
    vi.mocked(dependencies.lifecycle.commit).mockImplementation(async (_transaction, record) => {
      events.push("lifecycle.commit");
      return { ...record, state: "committed" as const, segmentVersion: record.segmentVersion + 1n };
    });
    const authority = new PlatformAdmissionOwnerAuthority({ ports: dependencies,
      mediaProjectionRecoveryKey, clock: () => now });

    const decision = await authority.finalizeRunAuthorization({
      caller,
      siteId: "site-1",
      commandId: "command-finalize",
      requestDigest: "e".repeat(64),
      effect: create(FinalizeRunAuthorizationEffectSchema, {
        manifestRef: "manifest-1",
        manifestDigest: "a".repeat(64),
        authorizationSegmentRef: "segment-1",
        expectedSegmentVersion: 1n,
        launchId: "launch-1",
        sessionIntentReceiptRef: "intent-receipt-1",
      }),
    });

    expect(decision.kind).toBe("committed");
    expect(dependencies.session.verifyFinalizeReceipts).toHaveBeenCalledWith({
      siteId: "site-1", sessionId: "session-1", launchId: "launch-1", manifestRef: "manifest-1",
      authorizationSegmentRef: "segment-1", expectedSegmentVersion: 1n,
      sessionIntentReceiptRef: "intent-receipt-1", commandId: "command-finalize",
      requestDigest: "e".repeat(64),
    }, expect.any(AbortSignal));
    expect(events).toEqual([
      "tx.begin", "lifecycle.read", "tx.end",
      "session.finalize-rpc",
      "tx.begin", "lifecycle.lock", "budget.commit", "lifecycle.commit", "tx.end",
    ]);
  });

  it("reads owner state, verifies Session no-dispatch evidence outside the DB transaction, then releases atomically", async () => {
    const events: string[] = [];
    const dependencies = ports(events);
    const authority = new PlatformAdmissionOwnerAuthority({ ports: dependencies,
      mediaProjectionRecoveryKey, clock: () => now });
    const evidenceRef = `session-dispatch-evidence:v1:${"b".repeat(64)}`;

    const decision = await authority.releaseRunAuthorization({
      caller,
      siteId: "site-1",
      commandId: "command-release",
      requestDigest: "e".repeat(64),
      effect: create(ReleaseRunAuthorizationEffectSchema, {
        manifestRef: "manifest-1",
        authorizationSegmentRef: "segment-1",
        expectedSegmentVersion: 1n,
        reasonCode: "DISPATCH_PAYLOAD_INVALID",
        noDispatchEvidenceRef: evidenceRef,
      }),
    });

    expect(decision.kind).toBe("released");
    expect(events).toEqual([
      "tx.begin", "lifecycle.read", "tx.end",
      "dispatch.rpc",
      "tx.begin", "lifecycle.lock", "budget.release", "lifecycle.release", "tx.end",
    ]);
  });

  it("replays an already committed finalize CAS instead of rejecting its advanced version", async () => {
    const dependencies = ports();
    const committedRecord = {
      siteId: "site-1",
      manifestRef: "manifest-1",
      manifestDigest: "a".repeat(64),
      sessionId: "session-1",
      launchId: "launch-1",
      runId: "run-1",
      rootHoldRef: "hold-1",
      authorizationSegmentRef: "segment-1",
      segmentVersion: 2n,
      state: "committed",
      expiresAt: "2026-07-29T12:04:00.000Z",
    } as const;
    vi.mocked(dependencies.lifecycle.read).mockResolvedValue(committedRecord);
    vi.mocked(dependencies.lifecycle.lock).mockResolvedValue(committedRecord);
    const authority = new PlatformAdmissionOwnerAuthority({ ports: dependencies,
      mediaProjectionRecoveryKey, clock: () => now });

    const decision = await authority.finalizeRunAuthorization({
      caller,
      siteId: "site-1",
      commandId: "command-finalize",
      requestDigest: "e".repeat(64),
      effect: create(FinalizeRunAuthorizationEffectSchema, {
        manifestRef: "manifest-1",
        manifestDigest: "a".repeat(64),
        authorizationSegmentRef: "segment-1",
        expectedSegmentVersion: 1n,
        launchId: "launch-1",
        sessionIntentReceiptRef: "intent-receipt-1",
      }),
    });

    expect(decision.kind).toBe("committed");
    expect(dependencies.budget.commitRoot).not.toHaveBeenCalled();
    expect(dependencies.session.verifyFinalizeReceipts).not.toHaveBeenCalled();
  });

  it("replays an already released CAS without re-querying Session evidence", async () => {
    const dependencies = ports();
    vi.mocked(dependencies.lifecycle.read).mockResolvedValue({
      siteId: "site-1",
      manifestRef: "manifest-1",
      manifestDigest: "a".repeat(64),
      sessionId: "session-1",
      launchId: "launch-1",
      runId: "run-1",
      rootHoldRef: "hold-1",
      authorizationSegmentRef: "segment-1",
      segmentVersion: 2n,
      state: "released",
      expiresAt: "2026-07-29T12:04:00.000Z",
    });
    const authority = new PlatformAdmissionOwnerAuthority({ ports: dependencies,
      mediaProjectionRecoveryKey, clock: () => now });

    const decision = await authority.releaseRunAuthorization({
      caller,
      siteId: "site-1",
      commandId: "command-release",
      requestDigest: "e".repeat(64),
      effect: create(ReleaseRunAuthorizationEffectSchema, {
        manifestRef: "manifest-1",
        authorizationSegmentRef: "segment-1",
        expectedSegmentVersion: 1n,
        reasonCode: "DISPATCH_PAYLOAD_INVALID",
        noDispatchEvidenceRef: `session-dispatch-evidence:v1:${"b".repeat(64)}`,
      }),
    });

    expect(decision.kind).toBe("already_released");
    expect(dependencies.dispatchEvidence.get).not.toHaveBeenCalled();
    expect(dependencies.budget.releaseRoot).not.toHaveBeenCalled();
  });

  it("marks a prepare failure before the owner effect boundary as retryable", async () => {
    const dependencies = ports();
    vi.mocked(dependencies.session.resolve).mockRejectedValue(new Error("session unavailable"));
    const authority = new PlatformAdmissionOwnerAuthority({ ports: dependencies,
      mediaProjectionRecoveryKey, clock: () => now });

    await expect(authority.prepareRun({
      caller, siteId: "site-1", commandId: "command-prepare-retry",
      requestDigest: "e".repeat(64), effect: prepareEffect(),
    })).rejects.toBeInstanceOf(AdmissionOwnerNoEffectError);

    expect(dependencies.budget.reserveRoot).not.toHaveBeenCalled();
  });

  it("keeps a Media reservation response loss ambiguous after the external effect starts", async () => {
    const dependencies = ports();
    const ambiguous = new Error("media reservation response lost");
    vi.mocked(dependencies.session.resolve).mockResolvedValue({
      kind: "resolved",
      value: { threadId: "session-1", assistantMessageId: "assistant-1" },
    });
    vi.mocked(dependencies.mediaProjection.issueReservation).mockRejectedValue(ambiguous);
    const authority = new PlatformAdmissionOwnerAuthority({ ports: dependencies,
      mediaProjectionRecoveryKey, clock: () => now });
    const effect = prepareEffect();
    effect.sessionProjectionAuthorizationHandle =
      `session-projection-authorization:${"s".repeat(32)}`;

    await expect(authority.prepareRun({
      caller, siteId: "site-1", commandId: "command-prepare-media-ambiguous",
      requestDigest: "e".repeat(64), effect,
    })).rejects.toBe(ambiguous);

    expect(dependencies.mediaProjection.issueReservation).toHaveBeenCalledOnce();
    expect(dependencies.budget.reserveRoot).not.toHaveBeenCalled();
  });

  it("keeps an execution-binding callback abort retryable because the local transaction rolls back", async () => {
    const dependencies = ports();
    const transient = new Error("execution binding transaction aborted");
    vi.mocked(dependencies.executionBinding.resolve).mockRejectedValueOnce(transient);
    const authority = new PlatformAdmissionOwnerAuthority({ ports: dependencies,
      mediaProjectionRecoveryKey, clock: () => now });
    const command = {
      caller, siteId: "site-1", commandId: "command-prepare-binding-retry",
      requestDigest: "e".repeat(64), effect: prepareEffect(),
    };

    await expect(authority.prepareRun(command)).rejects.toMatchObject({
      name: "AdmissionOwnerNoEffectError",
      cause: transient,
    });
    await expect(authority.prepareRun(command)).resolves.toMatchObject({ kind: "accepted" });

    expect(dependencies.executionBinding.resolve).toHaveBeenCalledTimes(2);
    expect(dependencies.budget.reserveRoot).toHaveBeenCalledOnce();
    expect(dependencies.lifecycle.prepare).toHaveBeenCalledOnce();
  });

  it("keeps a prepare budget callback abort retryable until the local callback completes", async () => {
    const dependencies = ports();
    const transient = new Error("prepare budget transaction aborted");
    vi.mocked(dependencies.budget.reserveRoot).mockRejectedValueOnce(transient);
    const authority = new PlatformAdmissionOwnerAuthority({ ports: dependencies,
      mediaProjectionRecoveryKey, clock: () => now });
    const command = {
      caller, siteId: "site-1", commandId: "command-prepare-budget-retry",
      requestDigest: "e".repeat(64), effect: prepareEffect(),
    };

    await expect(authority.prepareRun(command)).rejects.toMatchObject({
      name: "AdmissionOwnerNoEffectError",
      cause: transient,
    });
    await expect(authority.prepareRun(command)).resolves.toMatchObject({ kind: "accepted" });

    expect(dependencies.executionBinding.resolve).toHaveBeenCalledTimes(2);
    expect(dependencies.budget.reserveRoot).toHaveBeenCalledTimes(2);
    expect(dependencies.lifecycle.prepare).toHaveBeenCalledOnce();
  });

  it("keeps a prepare lifecycle callback abort retryable until the local callback completes", async () => {
    const dependencies = ports();
    const transient = new Error("prepare lifecycle transaction aborted");
    vi.mocked(dependencies.lifecycle.prepare).mockRejectedValueOnce(transient);
    const authority = new PlatformAdmissionOwnerAuthority({ ports: dependencies,
      mediaProjectionRecoveryKey, clock: () => now });
    const command = {
      caller, siteId: "site-1", commandId: "command-prepare-lifecycle-retry",
      requestDigest: "e".repeat(64), effect: prepareEffect(),
    };

    await expect(authority.prepareRun(command)).rejects.toMatchObject({
      name: "AdmissionOwnerNoEffectError",
      cause: transient,
    });
    await expect(authority.prepareRun(command)).resolves.toMatchObject({ kind: "accepted" });

    expect(dependencies.executionBinding.resolve).toHaveBeenCalledTimes(2);
    expect(dependencies.budget.reserveRoot).toHaveBeenCalledTimes(2);
    expect(dependencies.lifecycle.prepare).toHaveBeenCalledTimes(2);
  });

  it("keeps an effect-free execution-binding denial retryable across a UoW failure", async () => {
    const dependencies = ports();
    const rolledBack = new Error("read-only transaction completion failed");
    const baseExecute = dependencies.unitOfWork.execute;
    let unitOfWorkCalls = 0;
    dependencies.unitOfWork.execute = async <Result>(
      command: AdmissionAuthorityCommand,
      work: (transaction: PlatformTransaction) => Promise<Result>,
    ): Promise<Result> => {
      const result = await baseExecute(command, work);
      unitOfWorkCalls += 1;
      if (unitOfWorkCalls === 1) throw rolledBack;
      return result;
    };
    vi.mocked(dependencies.executionBinding.resolve).mockResolvedValue({
      kind: "denied",
      denial: { code: "ADMISSION_EXECUTION_SPACE_NOT_READY",
        retryClass: AdmissionRetryClass.AFTER_DELAY },
    });
    const authority = new PlatformAdmissionOwnerAuthority({ ports: dependencies,
      mediaProjectionRecoveryKey, clock: () => now });
    const command = {
      caller, siteId: "site-1", commandId: "command-prepare-binding-denied-retry",
      requestDigest: "e".repeat(64), effect: prepareEffect(),
    };

    await expect(authority.prepareRun(command)).rejects.toMatchObject({
      name: "AdmissionOwnerNoEffectError",
      cause: rolledBack,
    });
    await expect(authority.prepareRun(command)).resolves.toMatchObject({ kind: "denied" });

    expect(dependencies.executionBinding.resolve).toHaveBeenCalledTimes(2);
    expect(dependencies.budget.reserveRoot).not.toHaveBeenCalled();
  });

  it("keeps a post-binding denied callback commit response loss ambiguous", async () => {
    const dependencies = ports();
    const ambiguous = new Error("prepare denied commit response lost");
    const baseExecute = dependencies.unitOfWork.execute;
    dependencies.unitOfWork.execute = async <Result>(
      command: AdmissionAuthorityCommand,
      work: (transaction: PlatformTransaction) => Promise<Result>,
    ): Promise<Result> => {
      await baseExecute(command, work);
      throw ambiguous;
    };
    vi.mocked(dependencies.budget.reserveRoot).mockResolvedValue({
      kind: "denied",
      denial: { code: "ADMISSION_INSUFFICIENT_CREDIT", retryClass: AdmissionRetryClass.NEVER },
    });
    const authority = new PlatformAdmissionOwnerAuthority({ ports: dependencies,
      mediaProjectionRecoveryKey, clock: () => now });

    await expect(authority.prepareRun({
      caller, siteId: "site-1", commandId: "command-prepare-denied-ambiguous",
      requestDigest: "e".repeat(64), effect: prepareEffect(),
    })).rejects.toBe(ambiguous);

    expect(dependencies.executionBinding.resolve).toHaveBeenCalledOnce();
    expect(dependencies.budget.reserveRoot).toHaveBeenCalledOnce();
    expect(dependencies.lifecycle.prepare).not.toHaveBeenCalled();
  });

  it("keeps a prepare UoW commit response loss ambiguous after the callback completes", async () => {
    const dependencies = ports();
    const ambiguous = new Error("prepare commit response lost");
    const baseExecute = dependencies.unitOfWork.execute;
    dependencies.unitOfWork.execute = async <Result>(
      command: AdmissionAuthorityCommand,
      work: (transaction: PlatformTransaction) => Promise<Result>,
    ): Promise<Result> => {
      await baseExecute(command, work);
      throw ambiguous;
    };
    const authority = new PlatformAdmissionOwnerAuthority({ ports: dependencies,
      mediaProjectionRecoveryKey, clock: () => now });

    await expect(authority.prepareRun({
      caller, siteId: "site-1", commandId: "command-prepare-commit-ambiguous",
      requestDigest: "e".repeat(64), effect: prepareEffect(),
    })).rejects.toBe(ambiguous);

    expect(dependencies.budget.reserveRoot).toHaveBeenCalledOnce();
    expect(dependencies.lifecycle.prepare).toHaveBeenCalledOnce();
  });

  it("keeps a local prepare abort ambiguous after the external Media effect starts", async () => {
    const dependencies = ports();
    const localAbort = new Error("prepare local transaction aborted after Media reservation");
    vi.mocked(dependencies.session.resolve).mockResolvedValue({
      kind: "resolved",
      value: { threadId: "session-1", assistantMessageId: "assistant-1" },
    });
    vi.mocked(dependencies.budget.reserveRoot).mockRejectedValue(localAbort);
    const effect = prepareEffect();
    effect.sessionProjectionAuthorizationHandle =
      `session-projection-authorization:${"s".repeat(32)}`;
    const authority = new PlatformAdmissionOwnerAuthority({ ports: dependencies,
      mediaProjectionRecoveryKey, clock: () => now });

    await expect(authority.prepareRun({
      caller, siteId: "site-1", commandId: "command-prepare-media-local-ambiguous",
      requestDigest: "e".repeat(64), effect,
    })).rejects.toBe(localAbort);

    expect(dependencies.mediaProjection.issueReservation).toHaveBeenCalledOnce();
    expect(dependencies.budget.reserveRoot).toHaveBeenCalledOnce();
  });

  it("keeps a finalize Credit callback abort retryable until the local callback completes", async () => {
    const dependencies = ports();
    const transient = new Error("finalize Credit transaction aborted");
    vi.mocked(dependencies.budget.commitRoot).mockRejectedValueOnce(transient);
    vi.mocked(dependencies.lifecycle.commit).mockImplementation(
      async (_transaction, record, segmentVersion) => ({
        ...record, state: "committed" as const, segmentVersion,
      }),
    );
    const authority = new PlatformAdmissionOwnerAuthority({ ports: dependencies,
      mediaProjectionRecoveryKey, clock: () => now });
    const command = {
      caller, siteId: "site-1", commandId: "command-finalize-credit-retry",
      requestDigest: "e".repeat(64), effect: finalizeEffect(),
    };

    await expect(authority.finalizeRunAuthorization(command)).rejects.toMatchObject({
      name: "AdmissionOwnerNoEffectError",
      cause: transient,
    });
    await expect(authority.finalizeRunAuthorization(command))
      .resolves.toMatchObject({ kind: "committed" });

    expect(dependencies.budget.commitRoot).toHaveBeenCalledTimes(2);
    expect(dependencies.lifecycle.commit).toHaveBeenCalledOnce();
  });

  it("keeps a finalize lifecycle callback abort retryable until the local callback completes", async () => {
    const dependencies = ports();
    const transient = new Error("finalize lifecycle transaction aborted");
    vi.mocked(dependencies.lifecycle.commit)
      .mockRejectedValueOnce(transient)
      .mockImplementation(async (_transaction, record, segmentVersion) => ({
        ...record, state: "committed" as const, segmentVersion,
      }));
    const authority = new PlatformAdmissionOwnerAuthority({ ports: dependencies,
      mediaProjectionRecoveryKey, clock: () => now });
    const command = {
      caller, siteId: "site-1", commandId: "command-finalize-lifecycle-retry",
      requestDigest: "e".repeat(64), effect: finalizeEffect(),
    };

    await expect(authority.finalizeRunAuthorization(command)).rejects.toMatchObject({
      name: "AdmissionOwnerNoEffectError",
      cause: transient,
    });
    await expect(authority.finalizeRunAuthorization(command))
      .resolves.toMatchObject({ kind: "committed" });

    expect(dependencies.budget.commitRoot).toHaveBeenCalledTimes(2);
    expect(dependencies.lifecycle.commit).toHaveBeenCalledTimes(2);
  });

  it("keeps an expired finalize callback abort retryable until the local callback completes", async () => {
    const dependencies = ports();
    const transient = new Error("finalize expiry transaction aborted");
    const expiredRecord = {
      siteId: "site-1",
      manifestRef: "manifest-1",
      manifestDigest: "a".repeat(64),
      sessionId: "session-1",
      launchId: "launch-1",
      runId: "run-1",
      rootHoldRef: "hold-1",
      authorizationSegmentRef: "segment-1",
      segmentVersion: 1n,
      state: "reserved" as const,
      expiresAt: now.toISOString(),
    };
    vi.mocked(dependencies.lifecycle.read).mockResolvedValue(expiredRecord);
    vi.mocked(dependencies.lifecycle.lock).mockResolvedValue(expiredRecord);
    vi.mocked(dependencies.lifecycle.expire).mockRejectedValueOnce(transient);
    const authority = new PlatformAdmissionOwnerAuthority({ ports: dependencies,
      mediaProjectionRecoveryKey, clock: () => now });
    const command = {
      caller, siteId: "site-1", commandId: "command-finalize-expiry-retry",
      requestDigest: "e".repeat(64), effect: finalizeEffect(),
    };

    await expect(authority.finalizeRunAuthorization(command)).rejects.toMatchObject({
      name: "AdmissionOwnerNoEffectError",
      cause: transient,
    });
    await expect(authority.finalizeRunAuthorization(command))
      .resolves.toMatchObject({ kind: "expired" });

    expect(dependencies.budget.releaseRoot).toHaveBeenCalledTimes(2);
    expect(dependencies.lifecycle.expire).toHaveBeenCalledTimes(2);
    expect(dependencies.budget.commitRoot).not.toHaveBeenCalled();
  });

  it("keeps an expired finalize commit response loss ambiguous after the callback completes", async () => {
    const dependencies = ports();
    const ambiguous = new Error("finalize expiry commit response lost");
    const expiredRecord = {
      siteId: "site-1",
      manifestRef: "manifest-1",
      manifestDigest: "a".repeat(64),
      sessionId: "session-1",
      launchId: "launch-1",
      runId: "run-1",
      rootHoldRef: "hold-1",
      authorizationSegmentRef: "segment-1",
      segmentVersion: 1n,
      state: "reserved" as const,
      expiresAt: now.toISOString(),
    };
    vi.mocked(dependencies.lifecycle.read).mockResolvedValue(expiredRecord);
    vi.mocked(dependencies.lifecycle.lock).mockResolvedValue(expiredRecord);
    const baseExecute = dependencies.unitOfWork.execute;
    let unitOfWorkCalls = 0;
    dependencies.unitOfWork.execute = async <Result>(
      command: AdmissionAuthorityCommand,
      work: (transaction: PlatformTransaction) => Promise<Result>,
    ): Promise<Result> => {
      const result = await baseExecute(command, work);
      unitOfWorkCalls += 1;
      if (unitOfWorkCalls === 2) throw ambiguous;
      return result;
    };
    const authority = new PlatformAdmissionOwnerAuthority({ ports: dependencies,
      mediaProjectionRecoveryKey, clock: () => now });

    await expect(authority.finalizeRunAuthorization({
      caller, siteId: "site-1", commandId: "command-finalize-expiry-ambiguous",
      requestDigest: "e".repeat(64), effect: finalizeEffect(),
    })).rejects.toBe(ambiguous);

    expect(dependencies.budget.releaseRoot).toHaveBeenCalledOnce();
    expect(dependencies.lifecycle.expire).toHaveBeenCalledOnce();
    expect(dependencies.budget.commitRoot).not.toHaveBeenCalled();
  });

  it("keeps a raced finalize denial retryable across an effect-free UoW failure", async () => {
    const dependencies = ports();
    const rolledBack = new Error("finalize denial transaction completion failed");
    vi.mocked(dependencies.lifecycle.lock).mockImplementation(async () => ({
      siteId: "site-1",
      manifestRef: "manifest-1",
      manifestDigest: "a".repeat(64),
      sessionId: "session-1",
      launchId: "launch-1",
      runId: "run-1",
      rootHoldRef: "hold-1",
      authorizationSegmentRef: "segment-1",
      segmentVersion: 1n,
      state: "reconciliation_required" as const,
      expiresAt: "2026-07-29T12:04:00.000Z",
    }));
    const baseExecute = dependencies.unitOfWork.execute;
    let unitOfWorkCalls = 0;
    dependencies.unitOfWork.execute = async <Result>(
      command: AdmissionAuthorityCommand,
      work: (transaction: PlatformTransaction) => Promise<Result>,
    ): Promise<Result> => {
      const result = await baseExecute(command, work);
      unitOfWorkCalls += 1;
      if (unitOfWorkCalls === 2) throw rolledBack;
      return result;
    };
    const authority = new PlatformAdmissionOwnerAuthority({ ports: dependencies,
      mediaProjectionRecoveryKey, clock: () => now });
    const command = {
      caller, siteId: "site-1", commandId: "command-finalize-raced-denial-retry",
      requestDigest: "e".repeat(64), effect: finalizeEffect(),
    };

    await expect(authority.finalizeRunAuthorization(command)).rejects.toMatchObject({
      name: "AdmissionOwnerNoEffectError",
      cause: rolledBack,
    });
    await expect(authority.finalizeRunAuthorization(command))
      .resolves.toMatchObject({ kind: "denied" });

    expect(dependencies.budget.commitRoot).not.toHaveBeenCalled();
    expect(dependencies.budget.releaseRoot).not.toHaveBeenCalled();
  });

  it("keeps a finalize UoW commit response loss ambiguous after the callback completes", async () => {
    const dependencies = ports();
    const ambiguous = new Error("finalize commit response lost");
    const baseExecute = dependencies.unitOfWork.execute;
    let unitOfWorkCalls = 0;
    dependencies.unitOfWork.execute = async <Result>(
      command: AdmissionAuthorityCommand,
      work: (transaction: PlatformTransaction) => Promise<Result>,
    ): Promise<Result> => {
      const result = await baseExecute(command, work);
      unitOfWorkCalls += 1;
      if (unitOfWorkCalls === 2) throw ambiguous;
      return result;
    };
    vi.mocked(dependencies.lifecycle.commit).mockImplementation(
      async (_transaction, record, segmentVersion) => ({
        ...record, state: "committed" as const, segmentVersion,
      }),
    );
    const authority = new PlatformAdmissionOwnerAuthority({ ports: dependencies,
      mediaProjectionRecoveryKey, clock: () => now });

    await expect(authority.finalizeRunAuthorization({
      caller, siteId: "site-1", commandId: "command-finalize-commit-ambiguous",
      requestDigest: "e".repeat(64), effect: finalizeEffect(),
    })).rejects.toBe(ambiguous);

    expect(dependencies.budget.commitRoot).toHaveBeenCalledOnce();
    expect(dependencies.lifecycle.commit).toHaveBeenCalledOnce();
  });

  it("keeps a release Credit callback abort retryable until the local callback completes", async () => {
    const dependencies = ports();
    const transient = new Error("release Credit transaction aborted");
    vi.mocked(dependencies.budget.releaseRoot).mockRejectedValueOnce(transient);
    const authority = new PlatformAdmissionOwnerAuthority({ ports: dependencies,
      mediaProjectionRecoveryKey, clock: () => now });
    const command = {
      caller, siteId: "site-1", commandId: "command-release-credit-retry",
      requestDigest: "e".repeat(64), effect: releaseEffect(),
    };

    await expect(authority.releaseRunAuthorization(command)).rejects.toMatchObject({
      name: "AdmissionOwnerNoEffectError",
      cause: transient,
    });
    await expect(authority.releaseRunAuthorization(command))
      .resolves.toMatchObject({ kind: "released" });

    expect(dependencies.budget.releaseRoot).toHaveBeenCalledTimes(2);
    expect(dependencies.lifecycle.release).toHaveBeenCalledOnce();
  });

  it("keeps a release lifecycle callback abort retryable until the local callback completes", async () => {
    const dependencies = ports();
    const transient = new Error("release lifecycle transaction aborted");
    vi.mocked(dependencies.lifecycle.release).mockRejectedValueOnce(transient);
    const authority = new PlatformAdmissionOwnerAuthority({ ports: dependencies,
      mediaProjectionRecoveryKey, clock: () => now });
    const command = {
      caller, siteId: "site-1", commandId: "command-release-lifecycle-retry",
      requestDigest: "e".repeat(64), effect: releaseEffect(),
    };

    await expect(authority.releaseRunAuthorization(command)).rejects.toMatchObject({
      name: "AdmissionOwnerNoEffectError",
      cause: transient,
    });
    await expect(authority.releaseRunAuthorization(command))
      .resolves.toMatchObject({ kind: "released" });

    expect(dependencies.budget.releaseRoot).toHaveBeenCalledTimes(2);
    expect(dependencies.lifecycle.release).toHaveBeenCalledTimes(2);
  });

  it("keeps a release UoW commit response loss ambiguous after the callback completes", async () => {
    const dependencies = ports();
    const ambiguous = new Error("release commit response lost");
    const baseExecute = dependencies.unitOfWork.execute;
    let unitOfWorkCalls = 0;
    dependencies.unitOfWork.execute = async <Result>(
      command: AdmissionAuthorityCommand,
      work: (transaction: PlatformTransaction) => Promise<Result>,
    ): Promise<Result> => {
      const result = await baseExecute(command, work);
      unitOfWorkCalls += 1;
      if (unitOfWorkCalls === 2) throw ambiguous;
      return result;
    };
    const authority = new PlatformAdmissionOwnerAuthority({ ports: dependencies,
      mediaProjectionRecoveryKey, clock: () => now });

    await expect(authority.releaseRunAuthorization({
      caller, siteId: "site-1", commandId: "command-release-commit-ambiguous",
      requestDigest: "e".repeat(64), effect: releaseEffect(),
    })).rejects.toBe(ambiguous);

    expect(dependencies.budget.releaseRoot).toHaveBeenCalledOnce();
    expect(dependencies.lifecycle.release).toHaveBeenCalledOnce();
  });

  it("keeps a raced release rejection retryable across an effect-free UoW failure", async () => {
    const dependencies = ports();
    const rolledBack = new Error("release rejection transaction completion failed");
    vi.mocked(dependencies.lifecycle.lock).mockImplementation(async () => ({
      siteId: "site-1",
      manifestRef: "manifest-1",
      manifestDigest: "a".repeat(64),
      sessionId: "session-1",
      launchId: "launch-1",
      runId: "run-1",
      rootHoldRef: "hold-1",
      authorizationSegmentRef: "segment-1",
      segmentVersion: 1n,
      state: "committed" as const,
      expiresAt: "2026-07-29T12:04:00.000Z",
    }));
    const baseExecute = dependencies.unitOfWork.execute;
    let unitOfWorkCalls = 0;
    dependencies.unitOfWork.execute = async <Result>(
      command: AdmissionAuthorityCommand,
      work: (transaction: PlatformTransaction) => Promise<Result>,
    ): Promise<Result> => {
      const result = await baseExecute(command, work);
      unitOfWorkCalls += 1;
      if (unitOfWorkCalls === 2) throw rolledBack;
      return result;
    };
    const authority = new PlatformAdmissionOwnerAuthority({ ports: dependencies,
      mediaProjectionRecoveryKey, clock: () => now });
    const command = {
      caller, siteId: "site-1", commandId: "command-release-raced-rejection-retry",
      requestDigest: "e".repeat(64), effect: releaseEffect(),
    };

    await expect(authority.releaseRunAuthorization(command)).rejects.toMatchObject({
      name: "AdmissionOwnerNoEffectError",
      cause: rolledBack,
    });
    await expect(authority.releaseRunAuthorization(command))
      .resolves.toMatchObject({ kind: "not_releasable" });

    expect(dependencies.budget.releaseRoot).not.toHaveBeenCalled();
    expect(dependencies.lifecycle.release).not.toHaveBeenCalled();
  });

  it("marks a finalize observation failure before the owner effect boundary as retryable", async () => {
    const dependencies = ports();
    vi.mocked(dependencies.session.verifyFinalizeReceipts)
      .mockRejectedValue(new Error("session unavailable"));
    const authority = new PlatformAdmissionOwnerAuthority({ ports: dependencies,
      mediaProjectionRecoveryKey, clock: () => now });

    await expect(authority.finalizeRunAuthorization({
      caller, siteId: "site-1", commandId: "command-finalize-retry",
      requestDigest: "e".repeat(64), effect: finalizeEffect(),
    })).rejects.toBeInstanceOf(AdmissionOwnerNoEffectError);

    expect(dependencies.budget.commitRoot).not.toHaveBeenCalled();
  });

  it("marks a release observation failure before the owner effect boundary as retryable", async () => {
    const dependencies = ports();
    vi.mocked(dependencies.dispatchEvidence.get).mockRejectedValue(new Error("session unavailable"));
    const authority = new PlatformAdmissionOwnerAuthority({ ports: dependencies,
      mediaProjectionRecoveryKey, clock: () => now });

    await expect(authority.releaseRunAuthorization({
      caller, siteId: "site-1", commandId: "command-release-retry",
      requestDigest: "e".repeat(64), effect: releaseEffect(),
    })).rejects.toBeInstanceOf(AdmissionOwnerNoEffectError);

    expect(dependencies.budget.releaseRoot).not.toHaveBeenCalled();
  });

  it("marks a reconciliation observation failure before the owner effect boundary as retryable", async () => {
    const dependencies = ports();
    vi.mocked(dependencies.executionEvidence.resolve)
      .mockRejectedValue(new Error("agent evidence unavailable"));
    const authority = new PlatformAdmissionOwnerAuthority({ ports: dependencies,
      mediaProjectionRecoveryKey, clock: () => now });

    await expect(authority.reconcileRunAuthorization({
      caller, siteId: "site-1", commandId: "command-reconcile-retry",
      requestDigest: "e".repeat(64), effect: reconcileEffect(),
    })).rejects.toBeInstanceOf(AdmissionOwnerNoEffectError);

    expect(dependencies.budget.reconcileRoot).not.toHaveBeenCalled();
  });

  it("keeps an execution-observed reconciliation retryable across an effect-free UoW failure", async () => {
    const dependencies = ports();
    const rolledBack = new Error("execution-observed transaction completion failed");
    vi.mocked(dependencies.executionEvidence.resolve).mockResolvedValue({
      kind: "execution_observed",
      safeStatusRef: "execution-evidence-1",
    });
    const baseExecute = dependencies.unitOfWork.execute;
    let unitOfWorkCalls = 0;
    dependencies.unitOfWork.execute = async <Result>(
      command: AdmissionAuthorityCommand,
      work: (transaction: PlatformTransaction) => Promise<Result>,
    ): Promise<Result> => {
      const result = await baseExecute(command, work);
      unitOfWorkCalls += 1;
      if (unitOfWorkCalls === 2) throw rolledBack;
      return result;
    };
    const authority = new PlatformAdmissionOwnerAuthority({ ports: dependencies,
      mediaProjectionRecoveryKey, clock: () => now });
    const command = {
      caller, siteId: "site-1", commandId: "command-reconcile-execution-observed-retry",
      requestDigest: "e".repeat(64), effect: reconcileEffect(),
    };

    await expect(authority.reconcileRunAuthorization(command)).rejects.toMatchObject({
      name: "AdmissionOwnerNoEffectError",
      cause: rolledBack,
    });
    await expect(authority.reconcileRunAuthorization(command))
      .resolves.toMatchObject({ kind: "execution_observed" });

    expect(dependencies.budget.reconcileRoot).not.toHaveBeenCalled();
    expect(dependencies.lifecycle.settle).not.toHaveBeenCalled();
    expect(dependencies.lifecycle.requireReconciliation).not.toHaveBeenCalled();
  });

  it("marks a terminal reconciliation transaction abort as retryable until the callback reaches commit", async () => {
    const dependencies = ports();
    const transient = new Error("terminal credit transaction aborted");
    vi.mocked(dependencies.executionEvidence.resolve).mockResolvedValue(terminalExecutionEvidence());
    vi.mocked(dependencies.budget.reconcileRoot)
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce(settledReconciliationBudget());
    const authority = new PlatformAdmissionOwnerAuthority({ ports: dependencies,
      mediaProjectionRecoveryKey, clock: () => now });
    const command = {
      caller,
      siteId: "site-1",
      commandId: "command-reconcile-transaction-retry",
      requestDigest: "e".repeat(64),
      effect: reconcileEffect(),
    };

    await expect(authority.reconcileRunAuthorization(command))
      .rejects.toMatchObject({
        name: "AdmissionOwnerNoEffectError",
        cause: transient,
      });
    await expect(authority.reconcileRunAuthorization(command))
      .resolves.toMatchObject({ kind: "settled" });

    expect(dependencies.executionEvidence.resolve).toHaveBeenCalledTimes(2);
    expect(dependencies.dispatchEvidence.get).not.toHaveBeenCalled();
    expect(dependencies.budget.reconcileRoot).toHaveBeenCalledTimes(2);
    expect(dependencies.lifecycle.settle).toHaveBeenCalledOnce();
  });

  it("keeps a terminal lifecycle transaction abort retryable until the callback completes", async () => {
    const dependencies = ports();
    const transient = new Error("terminal lifecycle transaction aborted");
    vi.mocked(dependencies.executionEvidence.resolve).mockResolvedValue(terminalExecutionEvidence());
    vi.mocked(dependencies.budget.reconcileRoot).mockResolvedValue(settledReconciliationBudget());
    vi.mocked(dependencies.lifecycle.settle)
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce({
        siteId: "site-1",
        manifestRef: "manifest-1",
        manifestDigest: "a".repeat(64),
        sessionId: "session-1",
        launchId: "launch-1",
        runId: "run-1",
        rootHoldRef: "hold-1",
        authorizationSegmentRef: "segment-1",
        segmentVersion: 2n,
        state: "settled",
        expiresAt: "2026-07-29T12:04:00.000Z",
      });
    const authority = new PlatformAdmissionOwnerAuthority({ ports: dependencies,
      mediaProjectionRecoveryKey, clock: () => now });
    const command = {
      caller,
      siteId: "site-1",
      commandId: "command-reconcile-lifecycle-retry",
      requestDigest: "e".repeat(64),
      effect: reconcileEffect(),
    };

    await expect(authority.reconcileRunAuthorization(command))
      .rejects.toMatchObject({
        name: "AdmissionOwnerNoEffectError",
        cause: transient,
      });
    await expect(authority.reconcileRunAuthorization(command))
      .resolves.toMatchObject({ kind: "settled" });

    expect(dependencies.executionEvidence.resolve).toHaveBeenCalledTimes(2);
    expect(dependencies.budget.reconcileRoot).toHaveBeenCalledTimes(2);
    expect(dependencies.lifecycle.settle).toHaveBeenCalledTimes(2);
  });

  it("keeps terminal decision construction rollback-confirmed until the callback returns", async () => {
    const dependencies = ports();
    const transient = new Error("terminal decision clock unavailable");
    vi.mocked(dependencies.executionEvidence.resolve).mockResolvedValue(terminalExecutionEvidence());
    vi.mocked(dependencies.budget.reconcileRoot).mockResolvedValue(settledReconciliationBudget());
    const clock = vi.fn(() => now);
    clock.mockImplementationOnce(() => { throw transient; });
    const authority = new PlatformAdmissionOwnerAuthority({ ports: dependencies,
      mediaProjectionRecoveryKey, clock });
    const command = {
      caller,
      siteId: "site-1",
      commandId: "command-reconcile-decision-retry",
      requestDigest: "e".repeat(64),
      effect: reconcileEffect(),
    };

    await expect(authority.reconcileRunAuthorization(command))
      .rejects.toMatchObject({
        name: "AdmissionOwnerNoEffectError",
        cause: transient,
      });
    await expect(authority.reconcileRunAuthorization(command))
      .resolves.toMatchObject({ kind: "settled" });

    expect(clock).toHaveBeenCalledTimes(2);
    expect(dependencies.budget.reconcileRoot).toHaveBeenCalledTimes(2);
    expect(dependencies.lifecycle.settle).toHaveBeenCalledTimes(2);
  });

  it("keeps an outcome-unknown reconciliation callback abort retryable", async () => {
    const dependencies = ports();
    const transient = new Error("reconciliation lifecycle transaction aborted");
    vi.mocked(dependencies.dispatchEvidence.get).mockResolvedValue(outcomeUnknownDispatchEvidence());
    vi.mocked(dependencies.lifecycle.requireReconciliation)
      .mockRejectedValueOnce(transient)
      .mockImplementationOnce(async (_transaction, record, segmentVersion) => ({
        ...record,
        state: "reconciliation_required" as const,
        segmentVersion,
      }));
    const authority = new PlatformAdmissionOwnerAuthority({ ports: dependencies,
      mediaProjectionRecoveryKey, clock: () => now });
    const command = {
      caller,
      siteId: "site-1",
      commandId: "command-reconcile-outcome-unknown-retry",
      requestDigest: "e".repeat(64),
      effect: outcomeUnknownReconcileEffect(),
    };

    await expect(authority.reconcileRunAuthorization(command))
      .rejects.toMatchObject({
        name: "AdmissionOwnerNoEffectError",
        cause: transient,
      });
    await expect(authority.reconcileRunAuthorization(command))
      .resolves.toMatchObject({ kind: "reconciliation_required" });

    expect(dependencies.dispatchEvidence.get).toHaveBeenCalledTimes(2);
    expect(dependencies.executionEvidence.resolve).toHaveBeenCalledTimes(2);
    expect(dependencies.budget.reconcileRoot).toHaveBeenCalledTimes(2);
    expect(dependencies.lifecycle.requireReconciliation).toHaveBeenCalledTimes(2);
  });

  it("keeps outcome-unknown decision construction rollback-confirmed until the callback returns", async () => {
    const dependencies = ports();
    const transient = new Error("outcome-unknown decision clock unavailable");
    vi.mocked(dependencies.dispatchEvidence.get).mockResolvedValue(outcomeUnknownDispatchEvidence());
    const clock = vi.fn(() => now);
    clock.mockImplementationOnce(() => { throw transient; });
    const authority = new PlatformAdmissionOwnerAuthority({ ports: dependencies,
      mediaProjectionRecoveryKey, clock });
    const command = {
      caller,
      siteId: "site-1",
      commandId: "command-reconcile-outcome-unknown-decision-retry",
      requestDigest: "e".repeat(64),
      effect: outcomeUnknownReconcileEffect(),
    };

    await expect(authority.reconcileRunAuthorization(command))
      .rejects.toMatchObject({
        name: "AdmissionOwnerNoEffectError",
        cause: transient,
      });
    await expect(authority.reconcileRunAuthorization(command))
      .resolves.toMatchObject({ kind: "reconciliation_required" });

    expect(clock).toHaveBeenCalledTimes(2);
    expect(dependencies.budget.reconcileRoot).toHaveBeenCalledTimes(2);
    expect(dependencies.lifecycle.requireReconciliation).toHaveBeenCalledTimes(2);
  });

  it("keeps an outcome-unknown reconciliation commit response loss ambiguous", async () => {
    const dependencies = ports();
    const ambiguous = new Error("outcome-unknown reconciliation commit response lost");
    let unitOfWorkCalls = 0;
    const baseExecute = dependencies.unitOfWork.execute;
    dependencies.unitOfWork.execute = async <Result>(
      command: AdmissionAuthorityCommand,
      work: (transaction: PlatformTransaction) => Promise<Result>,
    ): Promise<Result> => {
      const result = await baseExecute(command, work);
      unitOfWorkCalls += 1;
      if (unitOfWorkCalls === 2) throw ambiguous;
      return result;
    };
    vi.mocked(dependencies.dispatchEvidence.get).mockResolvedValue(outcomeUnknownDispatchEvidence());
    const authority = new PlatformAdmissionOwnerAuthority({ ports: dependencies,
      mediaProjectionRecoveryKey, clock: () => now });

    await expect(authority.reconcileRunAuthorization({
      caller,
      siteId: "site-1",
      commandId: "command-reconcile-outcome-unknown-ambiguous",
      requestDigest: "e".repeat(64),
      effect: outcomeUnknownReconcileEffect(),
    })).rejects.toBe(ambiguous);

    expect(dependencies.budget.reconcileRoot).toHaveBeenCalledOnce();
    expect(dependencies.lifecycle.requireReconciliation).toHaveBeenCalledOnce();
  });

  it("keeps a reconciliation UoW commit failure ambiguous after the credit effect", async () => {
    const dependencies = ports();
    const ambiguous = new Error("owner commit response lost");
    let ownerUnitOfWorkCalls = 0;
    let creditEffects = 0;
    const baseExecute = dependencies.unitOfWork.execute;
    dependencies.unitOfWork.execute = async <Result>(
      command: AdmissionAuthorityCommand,
      work: (transaction: PlatformTransaction) => Promise<Result>,
    ): Promise<Result> => {
      const result = await baseExecute(command, work);
      ownerUnitOfWorkCalls += 1;
      if (ownerUnitOfWorkCalls === 2) throw ambiguous;
      return result;
    };
    vi.mocked(dependencies.executionEvidence.resolve).mockResolvedValue(terminalExecutionEvidence());
    vi.mocked(dependencies.budget.reconcileRoot).mockImplementation(async () => {
      creditEffects += 1;
      return settledReconciliationBudget();
    });
    const authority = new PlatformAdmissionOwnerAuthority({ ports: dependencies,
      mediaProjectionRecoveryKey, clock: () => now });

    await expect(authority.reconcileRunAuthorization({
      caller, siteId: "site-1", commandId: "command-reconcile-ambiguous",
      requestDigest: "e".repeat(64), effect: reconcileEffect(),
    })).rejects.toBe(ambiguous);

    expect(creditEffects).toBe(1);
  });

  it("advances outcome-unknown reconciliation through Credit before Admission", async () => {
    const dependencies = ports();
    vi.mocked(dependencies.dispatchEvidence.get).mockResolvedValue(outcomeUnknownDispatchEvidence());
    vi.mocked(dependencies.lifecycle.requireReconciliation).mockImplementation(
      async (_transaction, record, segmentVersion) => ({ ...record,
        state: "reconciliation_required" as const, segmentVersion }),
    );
    const authority = new PlatformAdmissionOwnerAuthority({ ports: dependencies,
      mediaProjectionRecoveryKey, clock: () => now });

    const decision = await authority.reconcileRunAuthorization({ caller, siteId: "site-1",
      commandId: "command-reconcile", requestDigest: "e".repeat(64),
      effect: outcomeUnknownReconcileEffect() });

    expect(decision.kind).toBe("reconciliation_required");
    expect(dependencies.budget.reconcileRoot).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ outcomeUnknownEvidenceRef: "dispatch-unknown-1" }));
    expect(dependencies.lifecycle.requireReconciliation).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), 2n,
    );
  });
});
