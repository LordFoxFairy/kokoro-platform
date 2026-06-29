import { describe, expect, it } from "vitest";
import { CreditService } from "../../src/application/credit-service.js";
import type {
  CreditAccount,
  CreditHold,
  CreditMutationResult,
  QuoteResult,
} from "../../src/domain/credit.js";
import type { CreditRepository, QuoteInput } from "../../src/domain/repository.js";

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

const hold: CreditHold = {
  id: "h1",
  accountId: "a1",
  amountMicros: "1",
  status: "active",
  idempotencyKey: "k1",
  expiresAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const quoteResult: QuoteResult = {
  featureKey: "model.call",
  labelKey: null,
  unit: "token",
  unitAmountMicros: "1",
  quantity: "1",
  amountMicros: "1",
};

function trackingRepo(): {
  repo: CreditRepository;
  calls: string[];
  quoteInputs: QuoteInput[];
} {
  const calls: string[] = [];
  const quoteInputs: QuoteInput[] = [];
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
    holdCredits: async () => {
      calls.push("holdCredits");
      return hold;
    },
    captureHold: async () => {
      calls.push("captureHold");
      return result;
    },
    releaseHold: async () => {
      calls.push("releaseHold");
      return hold;
    },
    quote: async (input) => {
      calls.push("quote");
      quoteInputs.push(input);
      return quoteResult;
    },
  };
  return { repo, calls, quoteInputs };
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
    ).rejects.toThrow();
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
    ).rejects.toThrow();
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

  it.each(["0", "-1", ""])("holdCredits rejects %j before repository", async (amountMicros) => {
    const { repo, calls } = trackingRepo();
    const service = new CreditService(repo);
    await expect(
      service.holdCredits({
        accountId: "a1",
        amountMicros,
        idempotencyKey: "k1",
      }),
    ).rejects.toThrow();
    expect(calls).not.toContain("holdCredits");
  });

  it.each(["0", "-1", ""])("captureHold rejects %j before repository", async (actualAmountMicros) => {
    const { repo, calls } = trackingRepo();
    const service = new CreditService(repo);
    await expect(
      service.captureHold({
        holdId: "h1",
        actualAmountMicros,
        idempotencyKey: "k1",
        reason: "model_call",
        featureKey: "model.call",
      }),
    ).rejects.toThrow();
    expect(calls).not.toContain("captureHold");
  });

  it("passes valid hold/capture/release through to repository", async () => {
    const { repo, calls } = trackingRepo();
    const service = new CreditService(repo);
    await service.holdCredits({ accountId: "a1", amountMicros: "100", idempotencyKey: "k1" });
    await service.captureHold({
      holdId: "h1",
      actualAmountMicros: "50",
      idempotencyKey: "k2",
      reason: "model_call",
      featureKey: "model.call",
    });
    await service.releaseHold({ holdId: "h1", idempotencyKey: "k3" });
    expect(calls).toEqual(["holdCredits", "captureHold", "releaseHold"]);
  });

  it("delegates ensureAccount to repository", async () => {
    const { repo, calls } = trackingRepo();
    const service = new CreditService(repo);
    await service.ensureAccount({ ownerKind: "user", ownerId: "u1" });
    expect(calls).toContain("ensureAccount");
  });

  it("defaults quantity to 1 when omitted", async () => {
    const { repo, quoteInputs } = trackingRepo();
    const service = new CreditService(repo);
    await service.quote({ featureKey: "model.call" });
    expect(quoteInputs[0]).toEqual({
      featureKey: "model.call",
      labelKey: undefined,
      quantity: "1",
    });
  });

  it("passes labelKey and quantity through to repository", async () => {
    const { repo, quoteInputs } = trackingRepo();
    const service = new CreditService(repo);
    await service.quote({ featureKey: "model.call", labelKey: "gpt-4", quantity: "7" });
    expect(quoteInputs[0]).toEqual({
      featureKey: "model.call",
      labelKey: "gpt-4",
      quantity: "7",
    });
  });

  it.each(["0", "-1", "", "abc"])(
    "quote rejects invalid quantity %j before repository",
    async (quantity) => {
      const { repo, calls } = trackingRepo();
      const service = new CreditService(repo);
      await expect(service.quote({ featureKey: "model.call", quantity })).rejects.toThrow();
      expect(calls).not.toContain("quote");
    },
  );
});
