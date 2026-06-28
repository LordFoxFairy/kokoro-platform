import { describe, expect, it } from "vitest";
import { CreditService } from "../../src/application/credit-service.js";
import type { CreditAccount, CreditMutationResult } from "../../src/domain/credit.js";
import type { CreditRepository } from "../../src/domain/repository.js";

const account: CreditAccount = {
  id: "a1",
  ownerKind: "user",
  ownerId: "u1",
  status: "active",
  balanceMicros: "0",
  heldMicros: "0",
  createdAt: new Date(0),
  updatedAt: new Date(0),
};
const result: CreditMutationResult = {
  account,
  entry: {
    id: "e1",
    accountId: "a1",
    amountMicros: "1",
    balanceAfterMicros: "1",
    reason: "subscription",
    idempotencyKey: "k1",
    requestId: null,
    createdAt: new Date(0),
  },
};

function trackingRepo(): { repo: CreditRepository; calls: string[] } {
  const calls: string[] = [];
  const repo: CreditRepository = {
    ensureAccount: async () => {
      calls.push("ensureAccount");
      return account;
    },
    grantCredits: async () => {
      calls.push("grantCredits");
      return result;
    },
    spendCredits: async () => {
      calls.push("spendCredits");
      return result;
    },
  };
  return { repo, calls };
}

describe("CreditService positive-amount guard", () => {
  it.each(["0", "-1", ""])("grantCredits rejects %j before repository", async (amountMicros) => {
    const { repo, calls } = trackingRepo();
    const service = new CreditService(repo);
    await expect(
      service.grantCredits({
        accountId: "a1",
        amountMicros,
        idempotencyKey: "k1",
        reason: "subscription",
      }),
    ).rejects.toThrow("amountMicros must be positive");
    expect(calls).not.toContain("grantCredits");
  });

  it.each(["0", "-1", ""])("spendCredits rejects %j before repository", async (amountMicros) => {
    const { repo, calls } = trackingRepo();
    const service = new CreditService(repo);
    await expect(
      service.spendCredits({
        accountId: "a1",
        amountMicros,
        idempotencyKey: "k1",
        reason: "model_call",
      }),
    ).rejects.toThrow("amountMicros must be positive");
    expect(calls).not.toContain("spendCredits");
  });

  it("passes valid grant through to repository", async () => {
    const { repo, calls } = trackingRepo();
    const service = new CreditService(repo);
    await service.grantCredits({
      accountId: "a1",
      amountMicros: "100",
      idempotencyKey: "k1",
      reason: "subscription",
    });
    expect(calls).toContain("grantCredits");
  });

  it("passes valid spend through to repository", async () => {
    const { repo, calls } = trackingRepo();
    const service = new CreditService(repo);
    await service.spendCredits({
      accountId: "a1",
      amountMicros: "100",
      idempotencyKey: "k1",
      reason: "model_call",
    });
    expect(calls).toContain("spendCredits");
  });

  it("delegates ensureAccount to repository", async () => {
    const { repo, calls } = trackingRepo();
    const service = new CreditService(repo);
    await service.ensureAccount({ ownerKind: "user", ownerId: "u1" });
    expect(calls).toContain("ensureAccount");
  });
});
