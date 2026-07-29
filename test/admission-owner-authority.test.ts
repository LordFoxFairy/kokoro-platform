import { create } from "@bufbuild/protobuf";
import { describe, expect, it, vi } from "vitest";
import {
  AdmissionRetryClass,
  ClientRunIntentSchema,
  FinalizeRunAuthorizationEffectSchema,
  OpaqueExecutionContextIntentSchema,
  PrepareRunEffectSchema,
  ReleaseRunAuthorizationEffectSchema,
} from "../src/interfaces/connect/generated/kokoro/platform/admission/v1/admission_pb.js";
import {
  PlatformAdmissionOwnerAuthority,
  type PlatformAdmissionOwnerPorts,
} from "../src/modules/admission/application/platform-admission-owner-authority.js";
import { createPlatformAdmissionOwnerAuthority } from "../src/process/admission-composition.js";
import {
  issuePlatformTransaction,
  revokePlatformTransaction,
} from "../src/shared/unit-of-work/platform-transaction.js";
import type { PlatformTransaction } from "../src/shared/unit-of-work/index.js";

const now = new Date("2026-07-29T12:00:00.000Z");
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
          value: {
            namespace: "opaque-namespace",
            threadId: "session-1",
            sessionExecutionBindingRef: "binding-1",
          },
        };
      }),
      verifyFinalizeReceipts: vi.fn(async () => {
        expect(transactionActive).toBe(false);
        events.push("session.finalize-rpc");
        return { kind: "verified" as const };
      }),
    },
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
          provider: "anthropic",
          name: "claude-sonnet",
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
      commitRoot: vi.fn(async () => undefined),
      releaseRoot: vi.fn(async () => { events.push("budget.release") }),
      reconcileRoot: vi.fn(async () => "reconciliation_required" as const),
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
      ...ownerPorts
    } = dependencies;
    const authority = createPlatformAdmissionOwnerAuthority({
      database: { internalTransaction },
      ownerPorts,
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
      budget: _budget,
      ...ownerPorts
    } = dependencies;

    expect(() => createPlatformAdmissionOwnerAuthority({
      database: { internalTransaction: vi.fn() },
      ownerPorts: ownerPorts as unknown as Omit<
        PlatformAdmissionOwnerPorts,
        "unitOfWork" | "lifecycle" | "site" | "model" | "runtimePolicy" | "capability"
      >,
      clock: () => now,
    })).toThrowError("PLATFORM_ADMISSION_OWNER_PORTS_REQUIRED");
  });

  it("resolves every Platform owner in one local UoW and freezes one complete GA request", async () => {
    const events: string[] = [];
    const dependencies = ports(events);
    const authority = new PlatformAdmissionOwnerAuthority({ ports: dependencies, clock: () => now });

    const decision = await authority.prepareRun({
      caller,
      siteId: "site-1",
      commandId: "command-1",
      requestDigest: "d".repeat(64),
      effect: prepareEffect(),
    });

    expect(decision.kind).toBe("accepted");
    if (decision.kind !== "accepted") throw new Error("unexpected decision");
    expect(decision.ownerFacts).toEqual({
      kind: "run.request",
      run_id: "run-1",
      thread_id: "session-1",
      input: { message_id: "message-1", content: "hello" },
      runtime: {
        agent_type: "general",
        model: { provider: "anthropic", name: "claude-sonnet", effort: "medium" },
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
      }>
      | undefined;
    expect(budgetInput?.manifestRef).toBe(`execution-manifest:sha256:${budgetInput?.manifestDigest}`);
    expect(budgetInput?.maximumExpiresAt).toBe("2026-07-29T12:05:00.000Z");
    expect(lifecycleInput).toMatchObject({
      manifestRef: budgetInput?.manifestRef,
      authorizationSegmentRef: "segment-1",
      segmentVersion: 1n,
      expiresAt: "2026-07-29T12:04:00.000Z",
    });
    expect(events).toEqual([
      "session", "tx.begin", "site", "runtime-policy", "model", "capability", "assets",
      "budget.reserve", "lifecycle.prepare", "tx.end",
    ]);
  });

  it("verifies Session finalize receipts outside the DB transaction before the local CAS", async () => {
    const events: string[] = [];
    const dependencies = ports(events);
    vi.mocked(dependencies.budget.commitRoot).mockImplementation(async () => {
      events.push("budget.commit");
    });
    vi.mocked(dependencies.lifecycle.commit).mockImplementation(async (_transaction, record) => {
      events.push("lifecycle.commit");
      return { ...record, state: "committed" as const, segmentVersion: record.segmentVersion + 1n };
    });
    const authority = new PlatformAdmissionOwnerAuthority({ ports: dependencies, clock: () => now });

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
    expect(events).toEqual([
      "tx.begin", "lifecycle.read", "tx.end",
      "session.finalize-rpc",
      "tx.begin", "lifecycle.lock", "budget.commit", "lifecycle.commit", "tx.end",
    ]);
  });

  it("reads owner state, verifies Session no-dispatch evidence outside the DB transaction, then releases atomically", async () => {
    const events: string[] = [];
    const dependencies = ports(events);
    const authority = new PlatformAdmissionOwnerAuthority({ ports: dependencies, clock: () => now });
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
    const authority = new PlatformAdmissionOwnerAuthority({ ports: dependencies, clock: () => now });

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
    const authority = new PlatformAdmissionOwnerAuthority({ ports: dependencies, clock: () => now });

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
});
