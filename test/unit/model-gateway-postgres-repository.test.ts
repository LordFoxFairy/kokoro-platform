import { describe, expect, it } from "vitest";
import type { ModelGatewayInvocationRecord } from
  "../../src/modules/model-gateway/application/model-gateway-service.js";
import { createModelGatewayResponseProtector } from
  "../../src/modules/model-gateway/infrastructure/crypto/response-protector.js";
import { PostgresModelGatewayRepository } from
  "../../src/modules/model-gateway/infrastructure/postgres/model-gateway-repository.js";
import {
  issuePlatformTransaction,
  revokePlatformTransaction,
  type PlatformSqlTransaction,
} from "../../src/shared/unit-of-work/platform-transaction.js";

class Sql implements PlatformSqlTransaction {
  readonly statements: string[] = [];
  readonly values: readonly unknown[][] = [];
  rows: readonly Record<string, unknown>[] = [];
  async query<Row extends Record<string, unknown>>(statement: string): Promise<readonly Row[]> {
    this.statements.push(statement);
    return this.rows as readonly Row[];
  }
  async execute(statement: string, values: readonly unknown[] = []): Promise<number> {
    this.statements.push(statement);
    (this.values as unknown[][]).push([...values]);
    return 1;
  }
}

const protector = createModelGatewayResponseProtector({
  currentKeyRevision: "revision-1",
  keys: [{ keyRevision: "revision-1", key: new Uint8Array(32).fill(9) }],
});

describe("PostgresModelGatewayRepository", () => {
  it("atomically-shaped writes contain encrypted terminal response, local usage fact and outbox", async () => {
    const sql = new Sql();
    const lease = issuePlatformTransaction(sql);
    try {
      const repository = new PostgresModelGatewayRepository({
        responseProtector: protector,
        reference: () => "outbox-1",
      });
      const prepared = record();
      await repository.persistPrepared(lease.transaction, prepared);
      await repository.persistTerminal(lease.transaction, {
        ...prepared,
        state: "succeeded",
        fenceEpoch: 2n,
        responseBody: new TextEncoder().encode('{"private":"do not persist plaintext"}'),
        evidenceRef: "evidence-1",
        sourceDigest: "b".repeat(64),
        usageEvidence: {
          evidenceKind: "measured",
          dimensions: [{ dimensionKey: "input_tokens", sourceUnit: "tokens", quantity: 2n }],
          attemptOutcome: "succeeded",
          occurredAt: "2029-01-01T00:00:01.000Z",
        },
        updatedAt: "2029-01-01T00:00:01.000Z",
      });

      const persisted = JSON.stringify(sql.values);
      expect(persisted).not.toContain("do not persist plaintext");
      expect(sql.statements.some((value) => value.startsWith("INSERT INTO platform.model_gateway_attempt_usage_fact")))
        .toBe(true);
      expect(sql.statements.filter((value) => value.startsWith("INSERT INTO platform.model_gateway_outbox")))
        .toHaveLength(2);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("decrypts only a terminal result bound to the exact invocation identity", async () => {
    const sql = new Sql();
    const lease = issuePlatformTransaction(sql);
    const plaintext = new TextEncoder().encode('{"id":"response"}');
    const base = record();
    sql.rows = [{
      ...row(base),
      state: "succeeded",
      responseEnvelope: protector.seal(plaintext, base),
      evidenceRef: "evidence-1",
      sourceDigest: "b".repeat(64),
    }];
    try {
      const repository = new PostgresModelGatewayRepository({ responseProtector: protector });
      const loaded = await repository.lockInvocation(lease.transaction, { logicalCallRef: "logical-call-1" });
      expect(loaded?.responseBody).toEqual(plaintext);
    } finally {
      revokePlatformTransaction(lease);
    }
  });
});

function record(): ModelGatewayInvocationRecord {
  return {
    siteId: "site-a", invocationRef: "invocation-a",
    modelAuthorizationHandle: `model-authorization:sha256:${"f".repeat(64)}`,
    executionManifestRef: `execution-manifest:sha256:${"a".repeat(64)}`,
    authorizationSegmentRef: "segment-a", logicalCallRef: "logical-call-1",
    attemptRef: "attempt-1", producerContext: "ga-run-1", producerGeneration: 1n,
    requestDigest: "a".repeat(64), gatewayModel: "chat-primary",
    maximumDimensions: [{ dimensionKey: "input_tokens", sourceUnit: "tokens", quantity: 10n }],
    attemptAuthorizationRef: "attempt-authorization-1", fenceEpoch: 1n,
    state: "dispatching", responseBody: null, usageEvidence: null, evidenceRef: null,
    sourceDigest: null, ownerEvidenceRef: null,
    createdAt: "2029-01-01T00:00:00.000Z", updatedAt: "2029-01-01T00:00:00.000Z",
  };
}

function row(value: ModelGatewayInvocationRecord): Record<string, unknown> {
  return {
    siteId: value.siteId, invocationRef: value.invocationRef,
    modelAuthorizationHandle: value.modelAuthorizationHandle,
    executionManifestRef: value.executionManifestRef,
    authorizationSegmentRef: value.authorizationSegmentRef,
    logicalCallRef: value.logicalCallRef, attemptRef: value.attemptRef,
    producerContext: value.producerContext, producerGeneration: value.producerGeneration,
    requestDigest: value.requestDigest, gatewayModel: value.gatewayModel,
    maximumDimensions: value.maximumDimensions.map((item) => ({
      ...item, quantity: item.quantity.toString(),
    })),
    attemptAuthorizationRef: value.attemptAuthorizationRef, fenceEpoch: value.fenceEpoch,
    state: value.state, responseEnvelope: null, evidenceRef: value.evidenceRef,
    sourceDigest: value.sourceDigest, ownerEvidenceRef: value.ownerEvidenceRef,
    createdAt: value.createdAt, updatedAt: value.updatedAt,
  };
}
