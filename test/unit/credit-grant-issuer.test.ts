import { describe, expect, it } from "vitest";
import { PostgresCreditGrantIssuer } from
  "../../src/modules/credit/infrastructure/postgres/credit-grant-issuer.js";
import { issuePlatformTransaction, revokePlatformTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";

describe("PostgresCreditGrantIssuer", () => {
  it("owns account, grant and balanced journal SQL inside the supplied Platform transaction", async () => {
    const statements: Array<Readonly<{ statement: string; values: readonly unknown[] }>> = [];
    const references = [
      "00000000-0000-7000-8000-000000000001",
      "00000000-0000-7000-8000-000000000101",
      "00000000-0000-7000-8000-000000000201",
    ];
    const lease = issuePlatformTransaction({
      query: async (statement, values = []) => {
        statements.push({ statement, values });
        return [];
      },
      execute: async (statement, values = []) => {
        statements.push({ statement, values });
        return 1;
      },
    });
    const issuer = new PostgresCreditGrantIssuer({ reference: () => references.shift()! });
    try {
      const preparation = await issuer.prepareIssuance(lease.transaction, { commandId: "command-1", grants: [grant()] });
      expect(preparation.kind).toBe("ready");
      if (preparation.kind !== "ready") throw new Error("test preparation rejected");

      const receipts = await issuer.issuePrepared(lease.transaction, {
        preparation: preparation.preparation,
      });

      expect(receipts).toEqual([{
        outputLineId: "credits",
        outputOrdinal: 1,
        occurrence: 1,
        creditProgramRevisionRef: "credit-v1",
        creditGrantRef: "00000000-0000-7000-8000-000000000101",
        outputVersion: 1,
        outputDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }]);
      const sql = statements.map(({ statement }) => statement).join("\n");
      expect(sql).toMatch(/pg_advisory_xact_lock[\s\S]+FROM platform\.credit_account[\s\S]+FOR UPDATE/u);
      expect(sql).toMatch(/INSERT INTO platform\.credit_account[\s\S]+INSERT INTO platform\.credit_grant/u);
      expect(sql).toContain("INSERT INTO platform.credit_journal_transaction");
      expect(sql.match(/INSERT INTO platform\.credit_journal_entry/gu)).toHaveLength(2);
      expect(sql).toContain("grant_issuance_source");
      expect(sql).toContain("customer_available");
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it.each(["suspended", "closed"] as const)("returns a closed unavailable result for a %s account", async (state) => {
    const lease = issuePlatformTransaction({
      query: async (statement) => statement.includes("FROM platform.credit_account") ? [{
        creditAccountId: "00000000-0000-7000-8000-000000000001",
        state,
        aggregateVersion: 1n,
      }] as never : [],
      execute: async () => 1,
    });
    try {
      await expect(new PostgresCreditGrantIssuer().prepareIssuance(lease.transaction,
        { commandId: "command-1", grants: [grant()] }))
        .resolves.toEqual({ kind: "unavailable", reason: `credit_account_${state}` });
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("rejects malformed or attribution-empty scope policies before any Credit mutation", async () => {
    const writes: string[] = [];
    const lease = issuePlatformTransaction({
      query: async () => [{ creditAccountId: "00000000-0000-7000-8000-000000000001",
        state: "active", aggregateVersion: 1n }] as never,
      execute: async (statement) => { writes.push(statement); return 1; },
    });
    const issuer = new PostgresCreditGrantIssuer();
    try {
      await expect(issuer.prepareIssuance(lease.transaction, {
        commandId: "command-1",
        grants: [{ ...grant(), scopePolicy: {
          version: 1,
          surfaceRefs: ["general.chat", "general.chat"],
          capabilityKeys: ["INVALID CAPABILITY"],
          agentRefs: [],
          allowUnattributedAgent: false,
        } }],
      })).rejects.toThrowError("CREDIT_GRANT_SCOPE_POLICY_INVALID");
      expect(writes).toEqual([]);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it.each([
    { override: { bucketClass: "unknown", expiresAt: "2026-07-30T01:00:00.000Z" }, code: "CREDIT_GRANT_BUCKET_INVALID" },
    { override: { burnPriority: 2_147_483_648 }, code: "CREDIT_GRANT_BURN_PRIORITY_INVALID" },
  ] as const)("rejects owner values outside the closed persistence domain: $code", async ({ override, code }) => {
    const writes: string[] = [];
    const lease = issuePlatformTransaction({
      query: async () => [{ creditAccountId: "00000000-0000-7000-8000-000000000001",
        state: "active", aggregateVersion: 1n }] as never,
      execute: async (statement) => { writes.push(statement); return 1; },
    });
    const issuer = new PostgresCreditGrantIssuer();
    try {
      await expect(issuer.prepareIssuance(lease.transaction, {
        commandId: "command-1",
        grants: [{ ...grant(), ...override } as never],
      })).rejects.toThrowError(code);
      expect(writes).toEqual([]);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("binds a preparation capability to one Platform transaction", async () => {
    const issuer = new PostgresCreditGrantIssuer();
    const first = issuePlatformTransaction({ query: async () => [], execute: async () => 1 });
    const second = issuePlatformTransaction({ query: async () => [], execute: async () => 1 });
    try {
      const preparation = await issuer.prepareIssuance(first.transaction, { commandId: "command-1", grants: [grant()] });
      if (preparation.kind !== "ready") throw new Error("test preparation rejected");
      await expect(issuer.issuePrepared(second.transaction, {
        preparation: preparation.preparation,
      })).rejects.toThrowError("CREDIT_GRANT_PREPARATION_INVALID");
    } finally {
      revokePlatformTransaction(first);
      revokePlatformTransaction(second);
    }
  });

  it("consumes a preparation capability after exactly one issuance", async () => {
    const references = [
      "00000000-0000-7000-8000-000000000001",
      "00000000-0000-7000-8000-000000000101",
      "00000000-0000-7000-8000-000000000201",
    ];
    const issuer = new PostgresCreditGrantIssuer({ reference: () => references.shift()! });
    const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 1 });
    try {
      const preparation = await issuer.prepareIssuance(lease.transaction, { commandId: "command-1", grants: [grant()] });
      if (preparation.kind !== "ready") throw new Error("test preparation rejected");
      const command = { preparation: preparation.preparation } as const;
      await expect(issuer.issuePrepared(lease.transaction, command)).resolves.toHaveLength(1);
      await expect(issuer.issuePrepared(lease.transaction, command))
        .rejects.toThrowError("CREDIT_GRANT_PREPARATION_CONSUMED");
    } finally {
      revokePlatformTransaction(lease);
    }
  });
});

function account() {
  return {
    siteId: "site-1",
    billingAccountId: "billing-1",
    unit: "credit",
    liabilityMerchantAccountId: "merchant-1",
  } as const;
}

function grant() {
  return {
    account: account(),
    outputLineId: "credits",
    outputOrdinal: 1,
    occurrence: 1,
    creditProgramRevisionRef: "credit-v1",
    sourceType: "redemption",
    sourceRef: "fulfillment-key:credits:1",
    businessOperationKey: "fulfillment:fulfillment-key:credits:1",
    bucketClass: "permanent",
    amount: "100",
    burnPriority: 100,
    scopePolicy: {
      version: 1,
      surfaceRefs: ["general.chat"],
      capabilityKeys: ["general.chat.message"],
      agentRefs: [],
      allowUnattributedAgent: true,
    },
    effectiveAt: "2026-07-29T01:00:00.000Z",
    expiresAt: null,
  } as const;
}
