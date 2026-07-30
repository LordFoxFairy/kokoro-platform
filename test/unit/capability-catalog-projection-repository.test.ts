import { describe, expect, it } from "vitest";
import {
  issuePlatformTransaction,
  revokePlatformTransaction,
  type PlatformSqlTransaction,
} from "../../src/shared/unit-of-work/platform-transaction.js";
import { PostgresCapabilityCatalogProjectionRepository } from
  "../../src/modules/admission/infrastructure/postgres/capability-catalog-projection-repository.js";
import type { CapabilityCatalogPublication } from
  "../../src/modules/admission/infrastructure/crypto/capability-publication-verifier.js";

const publication: CapabilityCatalogPublication = Object.freeze({
  siteId: "site-a",
  siteReleaseRef: "release-a",
  agentCatalogRef: `agent-catalog:sha256:${"a".repeat(64)}`,
  snapshotDigest: "a".repeat(64),
  snapshot: Object.freeze({
    schemaVersion: 1,
    agentOptions: [],
    tools: [],
    skillOptions: [],
    mcpOptions: [],
    subagents: [],
  }),
  frozenAt: "2026-07-29T12:00:00.000Z",
  signingKeyRef: "hub-signing-2026-07",
  signatureAlgorithm: "ed25519-sha256-v1",
  signaturePayloadDigest: "b".repeat(64),
  signature: new Uint8Array(64).fill(1),
});

describe("PostgresCapabilityCatalogProjectionRepository", () => {
  it("commits once and returns the original immutable receipt on exact replay", async () => {
    let committed = false;
    const statements: string[] = [];
    const database = transactionHost({
      execute: async (statement) => {
        statements.push(statement);
        if (statement.includes("INSERT INTO platform.capability_projection_command")) return committed ? 0 : 1;
        if (statement.includes("INSERT INTO platform.admission_capability_catalog_snapshot")) return 1;
        if (statement.includes("UPDATE platform.capability_projection_command")) {
          committed = true;
          return 1;
        }
        return 0;
      },
      query: async <Row extends Record<string, unknown>>(statement: string): Promise<readonly Row[]> => {
        statements.push(statement);
        if (statement.includes("set_config")) return [];
        if (statement.includes("FROM platform.capability_projection_command")) return [{
          siteId: "site-a", commandId: "command-a", callerIdentity: "spiffe://kokoro/hub",
          idempotencyKey: "idem-a", requestDigest: "c".repeat(64),
          state: committed ? "committed" : "processing",
          agentCatalogRef: committed ? publication.agentCatalogRef : null,
          recordedAt: "2026-07-29T12:00:01.000Z",
        }] as unknown as readonly Row[];
        if (statement.includes("FROM platform.site_release")) {
          return [{ agentCatalogRef: publication.agentCatalogRef }] as unknown as readonly Row[];
        }
        return [];
      },
    });
    const repository = new PostgresCapabilityCatalogProjectionRepository(database, {
      now: () => new Date("2026-07-29T12:00:01.000Z"),
    });
    const command = {
      callerIdentity: "spiffe://kokoro/hub",
      commandId: "command-a",
      idempotencyKey: "idem-a",
      requestDigest: "c".repeat(64),
      publication,
    };

    await expect(repository.project(command)).resolves.toMatchObject({ replayed: false });
    await expect(repository.project(command)).resolves.toEqual({
      agentCatalogRef: publication.agentCatalogRef,
      recordedAt: "2026-07-29T12:00:01.000Z",
      replayed: true,
    });
    expect(statements.some((statement) => statement.includes("FROM platform.site_release") &&
      statement.includes("state='ready'"))).toBe(true);
  });

  it("fails loud when an idempotency key is reused for different command evidence", async () => {
    const database = transactionHost({
      execute: async () => 0,
      query: async <Row extends Record<string, unknown>>(statement: string): Promise<readonly Row[]> =>
        statement.includes("set_config") ? [] : [{
          siteId: "site-a", commandId: "command-other", callerIdentity: "spiffe://kokoro/hub",
          idempotencyKey: "idem-a", requestDigest: "d".repeat(64), state: "processing",
          agentCatalogRef: null, recordedAt: "2026-07-29T12:00:01.000Z",
        }] as unknown as readonly Row[],
    });
    const repository = new PostgresCapabilityCatalogProjectionRepository(database);

    await expect(repository.project({
      callerIdentity: "spiffe://kokoro/hub",
      commandId: "command-a",
      idempotencyKey: "idem-a",
      requestDigest: "c".repeat(64),
      publication,
    })).rejects.toThrow("CAPABILITY_PROJECTION_COMMAND_CONFLICT");
  });
});

function transactionHost(sql: PlatformSqlTransaction) {
  return {
    internalTransaction: async <Result>(
      _operation: "capability.projection",
      work: (transaction: ReturnType<typeof issuePlatformTransaction>["transaction"]) => Promise<Result>,
    ): Promise<Result> => {
      const lease = issuePlatformTransaction(sql);
      try { return await work(lease.transaction); } finally { revokePlatformTransaction(lease); }
    },
  };
}
