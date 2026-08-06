import { describe, expect, it } from "vitest";
import type { ModelGatewayInvocationRecord } from
  "../../src/modules/model-gateway/application/model-gateway-service.js";
import { PostgresModelGatewayRepository } from
  "../../src/modules/model-gateway/infrastructure/postgres/model-gateway-repository.js";
import { issuePlatformTransaction, revokePlatformTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";

describe("PostgresModelGatewayRepository", () => {
  it("renews only the matching invocation and queue owner fences", async () => {
    const sql = new RecordingSql([1, 1]);
    const lease = issuePlatformTransaction(sql);
    try {
      await repository().heartbeat(lease.transaction, {
        record: invocation(),
        ownerInstanceRef: "model-gateway:instance-1",
        leaseExpiresAt: "2029-01-01T00:00:30.000Z",
      });
    } finally {
      revokePlatformTransaction(lease);
    }

    expect(sql.writes).toHaveLength(2);
    expect(sql.writes[0]?.statement).toMatch(
      /UPDATE platform\.model_gateway_invocation[\s\S]+state='dispatching'[\s\S]+dispatch_owner_ref=\$5[\s\S]+dispatch_lease_expires_at>now\(\)/u,
    );
    expect(sql.writes[0]?.values).toEqual([
      "2029-01-01T00:00:30.000Z",
      "site-1",
      "invocation-1",
      "a".repeat(64),
      "model-gateway:instance-1",
    ]);
    expect(sql.writes[1]?.statement).toMatch(
      /UPDATE platform\.model_gateway_dispatch_queue[\s\S]+state='dispatching'[\s\S]+dispatch_owner_ref=\$4[\s\S]+dispatch_lease_expires_at>now\(\)/u,
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
        leaseExpiresAt: "2029-01-01T00:00:30.000Z",
      })).rejects.toThrowError("MODEL_GATEWAY_DISPATCH_HEARTBEAT_FENCE_LOST");
    } finally {
      revokePlatformTransaction(lease);
    }
    expect(sql.writes).toHaveLength(1);
  });

  it("preserves an app-authored terminal timestamp while appending the terminal frame", async () => {
    const sql = new RecordingSql([1, 1], [{
      state: "succeeded",
      dispatchOwnerRef: "model-gateway:instance-1",
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
    expect(sql.writes[0]?.statement).toContain("updated_at=GREATEST(updated_at,now())");
  });
});

class RecordingSql {
  readonly writes: Array<{ statement: string; values?: readonly unknown[] }> = [];
  constructor(
    private readonly results: number[],
    private readonly queryRows: readonly Record<string, unknown>[] = [],
  ) {}
  async query<Row extends Record<string, unknown>>(): Promise<readonly Row[]> {
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
