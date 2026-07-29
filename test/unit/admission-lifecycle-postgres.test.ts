import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
  ClientRunIntentSchema,
  OpaqueExecutionContextIntentSchema,
  PrepareRunEffectSchema,
} from "../../src/interfaces/connect/generated/kokoro/platform/admission/v1/admission_pb.js";
import type { AdmissionLifecycleOwnerPort } from "../../src/modules/admission/application/platform-admission-owner-authority.js";
import { PostgresAdmissionLifecycleOwner } from "../../src/modules/admission/infrastructure/postgres/admission-lifecycle-owner.js";
import {
  issuePlatformTransaction,
  revokePlatformTransaction,
  type PlatformSqlTransaction,
} from "../../src/shared/unit-of-work/platform-transaction.js";

class LifecycleSql implements PlatformSqlTransaction {
  binding?: Record<string, unknown>;
  manifest?: Record<string, unknown>;
  readonly writeValues: unknown[][] = [];

  async query<Row extends Record<string, unknown>>(
    statement: string,
  ): Promise<readonly Row[]> {
    if (statement.includes("FROM platform.admission_session_execution_binding")) {
      return this.binding === undefined ? [] : [this.binding as Row];
    }
    if (statement.includes("FROM platform.admission_execution_manifest")) {
      return this.manifest === undefined ? [] : [this.manifest as Row];
    }
    throw new Error(`unexpected query: ${statement}`);
  }

  async execute(statement: string, values: readonly unknown[] = []): Promise<number> {
    this.writeValues.push([...values]);
    if (statement.startsWith("INSERT INTO platform.admission_session_execution_binding")) {
      this.binding = {
        siteId: values[0], sessionId: values[1], bindingRef: values[2], namespace: values[3],
        threadId: values[4], capabilitySnapshotRef: values[5], configurationRevisionId: values[6],
        bindingDigest: values[7],
      };
      return 1;
    }
    if (statement.startsWith("INSERT INTO platform.admission_execution_manifest")) {
      this.manifest = {
        siteId: values[0], manifestRef: values[1], manifestDigest: values[2], sessionId: values[3],
        launchId: values[4], runId: values[5], rootHoldRef: values[13],
        authorizationSegmentRef: values[14], segmentVersion: values[15], state: "reserved",
        expiresAt: values[16],
      };
      return 1;
    }
    if (statement.startsWith("UPDATE platform.admission_execution_manifest")) {
      if (this.manifest === undefined || this.manifest.state !== values[6] || this.manifest.segmentVersion !== values[7]) {
        return 0;
      }
      this.manifest = { ...this.manifest, state: values[0], segmentVersion: values[1] };
      return 1;
    }
    throw new Error(`unexpected execute: ${statement}`);
  }
}

const effect = create(PrepareRunEffectSchema, {
  sessionAccessGrant: "grant-1",
  projectRef: "project-1",
  sessionId: "session-1",
  launchId: "launch-1",
  proposedRunId: "run-1",
  triggerMessageId: "message-1",
  triggerMessageContent: "private prompt must not be persisted",
  modelOptionRevisionRef: "model-option-1",
  clientIntent: create(ClientRunIntentSchema, { effort: "medium", locale: "en-US" }),
  executionContext: create(OpaqueExecutionContextIntentSchema, {
    mode: { case: "continueFrom", value: { anchor: "private-parent-anchor", digest: "a".repeat(64) } },
  }),
});

const prepareInput: Parameters<AdmissionLifecycleOwnerPort["prepare"]>[1] = {
  siteId: "site-1",
  commandId: "command-1",
  requestDigest: "b".repeat(64),
  manifestRef: `execution-manifest:sha256:${"c".repeat(64)}`,
  manifestDigest: "c".repeat(64),
  maximumExpiresAt: "2026-07-29T12:05:00.000Z",
  sessionExecutionBindingRef: "binding-1",
  capabilitySnapshotRef: "capability-1",
  configurationRevisionId: "release-1",
  executionBudgetRootRef: "budget-1",
  rootHoldRef: "hold-1",
  authorizationSegmentRef: "segment-1",
  segmentVersion: 1n,
  expiresAt: "2026-07-29T12:04:00.000Z",
  ownerFacts: {
    kind: "run.request",
    run_id: "run-1",
    thread_id: "thread-1",
    input: { message_id: "message-1", content: "private prompt must not be persisted" },
    runtime: {
      agent_type: "general",
      model: { provider: "litellm", name: "claude-code", effort: "medium" },
      tools: ["read_file"], skills: [], mcp_servers: [], subagents: [], backend: "state",
      permissions: {
        approval_tools: [], review_tools: [], subagent_create: "deny",
        filesystem: "read_only",
      },
    },
    context: { namespace: "opaque-namespace", session_id: "session-1" },
  },
  effect,
};

describe("Postgres Admission lifecycle owner", () => {
  it("persists an idempotent binding and manifest without prompt or opaque lineage plaintext", async () => {
    const sql = new LifecycleSql();
    const lease = issuePlatformTransaction(sql);
    try {
      const lifecycle = new PostgresAdmissionLifecycleOwner();
      const record = await lifecycle.prepare(lease.transaction, prepareInput);

      expect(record).toEqual({
        siteId: "site-1", manifestRef: prepareInput.manifestRef,
        manifestDigest: prepareInput.manifestDigest, sessionId: "session-1", launchId: "launch-1",
        runId: "run-1", rootHoldRef: "hold-1", authorizationSegmentRef: "segment-1",
        segmentVersion: 1n, state: "reserved", expiresAt: prepareInput.expiresAt,
      });
      const persisted = JSON.stringify(sql.writeValues, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value);
      expect(persisted).not.toContain("private prompt must not be persisted");
      expect(persisted).not.toContain("private-parent-anchor");
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("fences lifecycle projection transitions by exact state and segment version", async () => {
    const sql = new LifecycleSql();
    const lease = issuePlatformTransaction(sql);
    try {
      const lifecycle = new PostgresAdmissionLifecycleOwner();
      const prepared = await lifecycle.prepare(lease.transaction, prepareInput);
      const committed = await lifecycle.commit(lease.transaction, prepared);

      expect(committed).toMatchObject({ state: "committed", segmentVersion: 2n });
      await expect(lifecycle.commit(lease.transaction, prepared)).rejects.toThrow(
        "ADMISSION_LIFECYCLE_CAS_LOST",
      );
    } finally {
      revokePlatformTransaction(lease);
    }
  });
});
