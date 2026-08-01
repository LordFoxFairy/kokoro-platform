import { describe, expect, it } from "vitest";
import { PostgresCommerceRepository } from "../../src/modules/commerce/infrastructure/postgres/repository.js";
import { createCommerceCommandIdentity } from "../../src/modules/commerce/domain/command-identity.js";
import { issuePlatformTransaction, revokePlatformTransaction, type PlatformSqlTransaction } from "../../src/shared/unit-of-work/platform-transaction.js";
import { canonicalCommandId } from "../../src/shared/outbox-inbox/receipt.js";

describe("PostgresCommerceRepository", () => {
  it("round-trips Model UUID v4 alongside the generic receipt identities without normalization", () => {
    expect(canonicalCommandId("00000000-0000-4000-8000-000000000001")).toBe("00000000-0000-4000-8000-000000000001");
    expect(canonicalCommandId("00000000-0000-7000-8000-000000000001")).toBe("00000000-0000-7000-8000-000000000001");
    expect(canonicalCommandId("a".repeat(32))).toBe("a".repeat(32));
    expect(() => canonicalCommandId("00000000-0000-4000-8000-00000000000A"))
      .toThrow("COMMAND_ID_INVALID");
  });
  it("locks the generic idempotency receipt before creating Commerce truth", async () => {
    const statements: string[] = [];
    const identity = commandIdentity();
    const sql: PlatformSqlTransaction = {
      execute: async (statement) => { statements.push(statement); return 1; },
      query: async (statement) => {
        statements.push(statement);
        if (statement.includes("FROM platform.command_receipt")) return [{ ...identity, state: "pending", result: null, resultDigest: null }] as never;
        if (statement.includes("INSERT INTO platform.commerce_command")) return [{ commandId: identity.commandId }] as never;
        return [];
      },
    };
    const lease = issuePlatformTransaction(sql);
    try {
      await expect(new PostgresCommerceRepository().claimCommand(lease.transaction, identity)).resolves.toMatchObject({ disposition: "execute" });
      expect(statements[0]).toContain("INSERT INTO platform.command_receipt");
      expect(statements[1]).toContain("FOR UPDATE");
      expect(statements[2]).toContain("INSERT INTO platform.commerce_command");
    } finally { revokePlatformTransaction(lease); }
  });

  it("rejects a different command id or digest before Commerce/business SQL", async () => {
    for (const conflict of ["command", "digest"] as const) {
      const statements: string[] = [];
      const identity = commandIdentity();
      const sql: PlatformSqlTransaction = {
        execute: async (statement) => { statements.push(statement); return 1; },
        query: async (statement) => {
          statements.push(statement);
          return [{ ...identity, commandId: conflict === "command" ? "b".repeat(32) : identity.commandId, requestDigest: conflict === "digest" ? "b".repeat(64) : identity.requestDigest, state: "pending", result: null, resultDigest: null }] as never;
        },
      };
      const lease = issuePlatformTransaction(sql);
      try {
        await expect(new PostgresCommerceRepository().claimCommand(lease.transaction, identity)).rejects.toThrow(
          conflict === "command" ? "COMMAND_IDENTITY_CONFLICT" : "IDEMPOTENCY_CONFLICT",
        );
        expect(statements.some((statement) => statement.includes("commerce_command"))).toBe(false);
      } finally { revokePlatformTransaction(lease); }
    }
  });

  it("validates a complete output plan before the first persistence statement", async () => {
    const statements: string[] = [];
    const lease = issuePlatformTransaction({ query: async () => [], execute: async (statement) => { statements.push(statement); return 1; } });
    try {
      await expect(new PostgresCommerceRepository().recordExpectedOutputPlan(lease.transaction, "00000000-0000-7000-8000-000000000001", [
        { outputLineId: "first", ordinal: 2, cardinality: 1, templateRevision: "v1", outputKind: "credit_grant", disposition: "required" },
      ])).rejects.toThrow("OUTPUT_ORDINAL_NOT_CONTINUOUS");
      expect(statements).toEqual([]);
    } finally { revokePlatformTransaction(lease); }
  });
});

function commandIdentity() {
  return createCommerceCommandIdentity({ commandId: "00000000-0000-7000-8000-000000000009", environment: "production", region: "us-east-1", siteId: "site-1", actorKind: "user", actorSubject: "user-1", actorGeneration: "3", operation: "confirmRedemption", idempotencyKey: "idem-1", commandVersion: "2026-07-28", requestDigest: "a".repeat(64) });
}
