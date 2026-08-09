import { describe, expect, it } from "vitest";
import type { ModelGatewayInvocationRecord, ModelGatewayOutcomeUnknownAuthority } from
  "../../src/modules/model-gateway/application/model-gateway-service.js";
import { PostgresModelGatewayRepository } from
  "../../src/modules/model-gateway/infrastructure/postgres/model-gateway-repository.js";
import { issuePlatformTransaction, revokePlatformTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";

describe("PostgresModelGatewayRepository", () => {
  it("persists accepted timestamps from PostgreSQL and returns that authoritative record", async () => {
    const sql = new RecordingSql([1, 1, 1, 1], [acceptedInvocationRow()]);
    const lease = issuePlatformTransaction(sql);
    const appAhead = "2029-01-02T00:00:00.000Z";
    let persisted: ModelGatewayInvocationRecord | null = null;
    try {
      persisted = await repository().persistAccepted(lease.transaction, {
        ...invocation(),
        state: "queued",
        maximumDimensions: [{
          dimensionKey: "output_tokens",
          sourceUnit: "token",
          quantity: 16n,
        }],
        dispatchOwnerRef: null,
        dispatchFence: 0n,
        dispatchLeaseExpiresAt: null,
        createdAt: appAhead,
        updatedAt: appAhead,
      }, modelRequest());
    } finally {
      revokePlatformTransaction(lease);
    }

    expect(persisted?.createdAt).toBe("2029-01-01T00:00:00.123Z");
    expect(persisted?.updatedAt).toBe("2029-01-01T00:00:00.123Z");
    expect(sql.writes[0]?.statement).toMatch(
      /total_frame_bytes,created_at,updated_at[\s\S]+date_trunc\('milliseconds',statement_timestamp\(\)\)[\s\S]+date_trunc\('milliseconds',statement_timestamp\(\)\)/u,
    );
    expect(persisted?.createdAt).toBe(persisted?.updatedAt);
    expect(sql.writes[0]?.values).not.toContain(appAhead);
    expect(sql.writes[3]?.values?.[4]).toContain("2029-01-01T00:00:00.123Z");
  });

  it("renews only the matching invocation and queue owner fences", async () => {
    const sql = new RecordingSql([1, 1], [invocationRow()]);
    const lease = issuePlatformTransaction(sql);
    try {
      await repository().heartbeat(lease.transaction, {
        record: invocation(),
        ownerInstanceRef: "model-gateway:instance-1",
        leaseDurationMs: 1_000,
      });
    } finally {
      revokePlatformTransaction(lease);
    }

    expect(sql.writes).toHaveLength(2);
    expect(sql.writes[0]?.statement).toMatch(
      /SET dispatch_lease_expires_at=date_trunc\('milliseconds',clock_timestamp\(\)\)\+[\s\S]+\(\$1::bigint\*interval '1 millisecond'\)[\s\S]+state='dispatching'[\s\S]+dispatch_owner_ref=\$5[\s\S]+dispatch_fence=\$6::bigint[\s\S]+dispatch_lease_expires_at>clock_timestamp\(\)/u,
    );
    expect(sql.writes[0]?.values).toEqual([
      "1000",
      "site-1",
      "invocation-1",
      "a".repeat(64),
      "model-gateway:instance-1",
      "1",
    ]);
    expect(sql.writes[1]?.statement).toMatch(
      /SET dispatch_lease_expires_at=date_trunc\('milliseconds',clock_timestamp\(\)\)\+[\s\S]+\(\$1::bigint\*interval '1 millisecond'\)[\s\S]+state='dispatching'[\s\S]+dispatch_owner_ref=\$4[\s\S]+dispatch_lease_expires_at>clock_timestamp\(\)/u,
    );
    expect(sql.writeSql()).not.toMatch(/state='terminal'|INSERT|DELETE/u);
  });

  it("fails the heartbeat fence before touching the queue for a stale owner", async () => {
    const sql = new RecordingSql([0]);
    const lease = issuePlatformTransaction(sql);
    try {
      await expect(repository().heartbeat(lease.transaction, {
        record: invocation(),
        ownerInstanceRef: "model-gateway:stale-owner",
        leaseDurationMs: 1_000,
      })).rejects.toThrowError("MODEL_GATEWAY_DISPATCH_HEARTBEAT_FENCE_LOST");
    } finally {
      revokePlatformTransaction(lease);
    }
    expect(sql.writes).toHaveLength(1);
  });

  it("claims with a bounded lease rooted in the PostgreSQL clock", async () => {
    const sql = new RecordingSql([1, 1, 1], [invocationRow()]);
    const lease = issuePlatformTransaction(sql);
    let claimed: ModelGatewayInvocationRecord | null = null;
    try {
      claimed = await repository().claimInvocation(lease.transaction, {
        record: { ...invocation(), state: "queued", dispatchOwnerRef: null,
          dispatchFence: 0n, dispatchLeaseExpiresAt: null },
        ownerInstanceRef: "model-gateway:instance-1",
        leaseDurationMs: 1_000,
      });
    } finally {
      revokePlatformTransaction(lease);
    }

    expect(claimed?.dispatchLeaseExpiresAt).toBe("2029-01-01T00:00:01.000Z");
    expect(sql.writes[1]?.statement).toMatch(
      /dispatch_lease_expires_at=date_trunc\('milliseconds',clock_timestamp\(\)\)\+[\s\S]+\(\$2::bigint\*interval '1 millisecond'\)[\s\S]+updated_at=clock_timestamp\(\)/u,
    );
    expect(sql.writes[1]?.values?.slice(0, 2)).toEqual([
      "model-gateway:instance-1",
      "1000",
    ]);
    expect(sql.writes[2]?.statement).toMatch(
      /dispatch_lease_expires_at=date_trunc\('milliseconds',clock_timestamp\(\)\)\+[\s\S]+\(\$2::bigint\*interval '1 millisecond'\)/u,
    );
  });

  it("rejects an unbounded lease duration before a claim or heartbeat write", async () => {
    for (const leaseDurationMs of [999, 600_001, 1_000.5]) {
      const sql = new RecordingSql([]);
      const lease = issuePlatformTransaction(sql);
      try {
        await expect(repository().heartbeat(lease.transaction, {
          record: invocation(),
          ownerInstanceRef: "model-gateway:instance-1",
          leaseDurationMs,
        })).rejects.toThrowError("MODEL_GATEWAY_DISPATCH_LEASE_DURATION_INVALID");
      } finally {
        revokePlatformTransaction(lease);
      }
      expect(sql.writes).toHaveLength(0);
    }
  });

  it("uses the locked PostgreSQL clock and original fence when appending a live frame", async () => {
    const sql = new RecordingSql([1, 1], [{
      state: "dispatching",
      dispatchOwnerRef: "model-gateway:instance-1",
      dispatchFence: "1",
      dispatchLeaseExpiresAt: "2020-01-01T00:00:00.000Z",
      lastFrameSequence: "1",
      lastFrameDigest: "f".repeat(64),
      frameCount: "1",
      totalFrameBytes: "128",
    }]);
    const lease = issuePlatformTransaction(sql);
    try {
      await repository().appendFrame(lease.transaction, {
        record: invocation(),
        ownerInstanceRef: "model-gateway:instance-1",
        payload: { kind: "content_delta", content: "hello" },
      });
    } finally {
      revokePlatformTransaction(lease);
    }

    expect(sql.reads[0]?.statement).toContain(
      'dispatch_fence AS "dispatchFence"',
    );
    expect(sql.writes[0]?.statement).toMatch(
      /dispatch_owner_ref=\$9[\s\S]+dispatch_fence=\$10::bigint[\s\S]+dispatch_lease_expires_at>clock_timestamp\(\)/u,
    );
    expect(sql.writes[0]?.values?.slice(8)).toEqual([
      "model-gateway:instance-1",
      "1",
    ]);
    expect(sql.writes).toHaveLength(2);
  });

  it("rejects an original frame owner after its dispatch fence drifts", async () => {
    const sql = new RecordingSql([1, 1], [{
      state: "dispatching",
      dispatchOwnerRef: "model-gateway:instance-1",
      dispatchFence: "2",
      dispatchLeaseExpiresAt: "2029-01-01T00:00:30.000Z",
      lastFrameSequence: "1",
      lastFrameDigest: "f".repeat(64),
      frameCount: "1",
      totalFrameBytes: "128",
    }]);
    const lease = issuePlatformTransaction(sql);
    try {
      await expect(repository().appendFrame(lease.transaction, {
        record: invocation(),
        ownerInstanceRef: "model-gateway:instance-1",
        payload: { kind: "content_delta", content: "hello" },
      })).rejects.toThrowError("MODEL_GATEWAY_DISPATCH_FENCE_LOST");
    } finally {
      revokePlatformTransaction(lease);
    }
    expect(sql.writes).toHaveLength(0);
  });

  it("requires an expired observation to retain the same owner, fence, and lease at unknown CAS", async () => {
    const sql = new RecordingSql([1, 1, 1, 1]);
    const lease = issuePlatformTransaction(sql);
    const instance = repository();
    const changed: ModelGatewayInvocationRecord = Object.freeze({
      ...invocation(),
      state: "outcome_unknown",
      fenceEpoch: 2n,
      ownerEvidenceRef: `model-gateway-owner-expired:sha256:${"c".repeat(64)}`,
      updatedAt: "2029-01-01T00:00:20.000Z",
    });
    try {
      await instance.persistOutcomeUnknown(lease.transaction, changed, {
        kind: "expired",
        observedOwnerInstanceRef: "model-gateway:instance-1",
        observedDispatchFence: 1n,
        observedLeaseExpiresAt: "2029-01-01T00:00:10.000Z",
      } satisfies ModelGatewayOutcomeUnknownAuthority);
    } finally {
      revokePlatformTransaction(lease);
    }

    expect(sql.writes[0]?.statement).toMatch(
      /dispatch_owner_ref=\$8[\s\S]+dispatch_fence=\$9::bigint[\s\S]+\$10='expired'[\s\S]+dispatch_lease_expires_at=\$11::timestamptz[\s\S]+dispatch_lease_expires_at<=clock_timestamp\(\)/u,
    );
    expect(sql.writes[0]?.values?.slice(7)).toEqual([
      "model-gateway:instance-1",
      "1",
      "expired",
      "2029-01-01T00:00:10.000Z",
    ]);
  });

  it("finalizes a live dispatch only with its original owner fence and an unexpired lease", async () => {
    const sql = new RecordingSql([1, 1, 1, 1, 1]);
    const lease = issuePlatformTransaction(sql);
    const terminal: ModelGatewayInvocationRecord = Object.freeze({
      ...invocation(),
      state: "succeeded",
      responseBody: new Uint8Array([1]),
      fenceEpoch: 2n,
      usageEvidence: Object.freeze({
        evidenceKind: "measured",
        dimensions: Object.freeze([]),
        attemptOutcome: "succeeded",
        occurredAt: "2029-01-01T00:00:20.000Z",
      }),
      evidenceRef: "evidence-1",
      sourceDigest: "b".repeat(64),
      dispatchOwnerRef: "model-gateway:replacement-owner",
      dispatchFence: 2n,
      updatedAt: "2029-01-01T00:00:20.000Z",
    });
    try {
      await repository().persistTerminal(lease.transaction, terminal, "dispatching", {
        ownerInstanceRef: "model-gateway:instance-1",
        dispatchFence: 1n,
      });
    } finally {
      revokePlatformTransaction(lease);
    }

    expect(sql.writes[0]?.statement).toMatch(
      /dispatch_owner_ref=\$11[\s\S]+dispatch_fence=\$13::bigint[\s\S]+dispatch_lease_expires_at>clock_timestamp\(\)/u,
    );
    expect(sql.writes[0]?.values?.slice(10)).toEqual([
      "model-gateway:instance-1",
      "dispatching",
      "1",
    ]);
  });

  it("keeps outcome-unknown reconciliation independent of live dispatch authority", async () => {
    const sql = new RecordingSql([1, 1, 1]);
    const lease = issuePlatformTransaction(sql);
    const terminal: ModelGatewayInvocationRecord = Object.freeze({
      ...invocation(),
      state: "succeeded",
      responseBody: new Uint8Array([1]),
      fenceEpoch: 3n,
      usageEvidence: Object.freeze({
        evidenceKind: "measured",
        dimensions: Object.freeze([]),
        attemptOutcome: "succeeded",
        occurredAt: "2029-01-01T00:00:20.000Z",
      }),
      evidenceRef: "evidence-1",
      sourceDigest: "b".repeat(64),
      updatedAt: "2029-01-01T00:00:20.000Z",
    });
    try {
      await repository().persistTerminal(lease.transaction, terminal, "outcome_unknown", null);
    } finally {
      revokePlatformTransaction(lease);
    }

    expect(sql.writes[0]?.statement).toContain("$12='outcome_unknown' OR");
    expect(sql.writes[0]?.values?.slice(10)).toEqual(["", "outcome_unknown", "0"]);
    expect(sql.writes).toHaveLength(3);
  });

  it("preserves an app-authored terminal timestamp while appending the terminal frame", async () => {
    const sql = new RecordingSql([1, 1], [{
      state: "succeeded",
      dispatchOwnerRef: "model-gateway:instance-1",
      dispatchFence: "1",
      dispatchLeaseExpiresAt: "2029-01-01T00:00:30.000Z",
      lastFrameSequence: "1",
      lastFrameDigest: "f".repeat(64),
      frameCount: "1",
      totalFrameBytes: "128",
    }]);
    const lease = issuePlatformTransaction(sql);
    try {
      await repository().appendTerminalFrame(lease.transaction, {
        ...invocation(),
        state: "succeeded",
        responseBody: new Uint8Array([1]),
        fenceEpoch: 2n,
        usageEvidence: {
          evidenceKind: "measured",
          dimensions: [],
          attemptOutcome: "succeeded",
          occurredAt: "2029-01-01T00:00:20.000Z",
        },
        evidenceRef: "evidence-1",
        sourceDigest: "b".repeat(64),
        updatedAt: "2029-01-01T00:00:20.000Z",
      }, {
        kind: "completed",
        responseBody: new Uint8Array([1]),
      });
    } finally {
      revokePlatformTransaction(lease);
    }
    expect(sql.writes[0]?.statement)
      .toContain("updated_at=GREATEST(updated_at,clock_timestamp())");
  });
});

class RecordingSql {
  readonly reads: Array<{ statement: string; values?: readonly unknown[] }> = [];
  readonly writes: Array<{ statement: string; values?: readonly unknown[] }> = [];
  constructor(
    private readonly results: number[],
    private readonly queryRows: readonly Record<string, unknown>[] = [],
  ) {}
  async query<Row extends Record<string, unknown>>(
    statement: string,
    values?: readonly unknown[],
  ): Promise<readonly Row[]> {
    this.reads.push(values === undefined ? { statement } : { statement, values });
    return this.queryRows as readonly Row[];
  }
  async execute(statement: string, values?: readonly unknown[]): Promise<number> {
    this.writes.push(values === undefined ? { statement } : { statement, values });
    return this.results.shift() ?? 0;
  }
  writeSql(): string { return this.writes.map(({ statement }) => statement).join("\n"); }
}

function repository(): PostgresModelGatewayRepository {
  return new PostgresModelGatewayRepository({
    responseProtector: {
      seal: () => ({
        algorithm: "A256GCM",
        keyRevision: "test-key-v1",
        nonce: "a",
        ciphertext: "b",
        authenticationTag: "c",
      }),
      unseal: () => { throw new Error("TEST_RESPONSE_PROTECTOR_NOT_EXPECTED"); },
    },
  });
}

function invocation(): ModelGatewayInvocationRecord {
  return Object.freeze({
    siteId: "site-1",
    invocationRef: "invocation-1",
    modelAuthorizationHandle: `model-authorization:sha256:${"b".repeat(64)}`,
    executionManifestRef: "execution-manifest-1",
    authorizationSegmentRef: "authorization-segment-1",
    logicalCallRef: "logical-call-1",
    attemptRef: "attempt-1",
    producerContext: "ga-run-1",
    producerGeneration: 1n,
    requestDigest: "a".repeat(64),
    gatewayModel: "chat-primary",
    maximumDimensions: [],
    attemptAuthorizationRef: "attempt-authorization-1",
    fenceEpoch: 1n,
    state: "dispatching",
    responseBody: null,
    usageEvidence: null,
    evidenceRef: null,
    sourceDigest: null,
    ownerEvidenceRef: null,
    dispatchOwnerRef: "model-gateway:instance-1",
    dispatchFence: 1n,
    dispatchLeaseExpiresAt: "2029-01-01T00:00:10.000Z",
    createdAt: "2029-01-01T00:00:00.000Z",
    updatedAt: "2029-01-01T00:00:00.000Z",
  });
}

function invocationRow(): Record<string, unknown> {
  return {
    siteId: "site-1",
    invocationRef: "invocation-1",
    modelAuthorizationHandle: `model-authorization:sha256:${"b".repeat(64)}`,
    executionManifestRef: "execution-manifest-1",
    authorizationSegmentRef: "authorization-segment-1",
    logicalCallRef: "logical-call-1",
    attemptRef: "attempt-1",
    producerContext: "ga-run-1",
    producerGeneration: "1",
    requestDigest: "a".repeat(64),
    requestEnvelope: {},
    gatewayModel: "chat-primary",
    maximumDimensions: [{ dimensionKey: "output_tokens", sourceUnit: "token", quantity: "16" }],
    attemptAuthorizationRef: "attempt-authorization-1",
    fenceEpoch: "1",
    state: "dispatching",
    responseEnvelope: null,
    evidenceRef: null,
    sourceDigest: null,
    ownerEvidenceRef: null,
    dispatchOwnerRef: "model-gateway:instance-1",
    dispatchFence: "1",
    dispatchLeaseExpiresAt: "2029-01-01T00:00:01.000Z",
    createdAt: "2029-01-01T00:00:00.000Z",
    updatedAt: "2029-01-01T00:00:00.000Z",
  };
}

function acceptedInvocationRow(): Record<string, unknown> {
  return {
    ...invocationRow(),
    state: "queued",
    dispatchOwnerRef: null,
    dispatchFence: "0",
    dispatchLeaseExpiresAt: null,
    createdAt: "2029-01-01T00:00:00.123Z",
    updatedAt: "2029-01-01T00:00:00.123Z",
  };
}

function modelRequest() {
  return {
    protocol: "openai.chat.completions.v1" as const,
    model: "chat-primary",
    messages: [{ role: "user" as const, content: "hello", toolCalls: [] }],
    maxOutputTokens: 16,
    tools: [],
    toolChoice: "none" as const,
  };
}
