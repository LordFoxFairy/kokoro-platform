import { describe, expect, it } from "vitest";
import { AppError } from "@kokoro/platform-kit";
import { CreditService, type OwnerSiteActiveChecker } from "../../src/application/credit-service.js";
import type {
  CreditAccount,
  CreditHold,
  CreditMutationResult,
  PricingRule,
  QuoteResult,
} from "../../src/domain/credit.js";
import type { DeleteInput, RestoreInput } from "../../src/domain/credit-lifecycle.js";
import type { CreditRepository, QuoteInput } from "../../src/domain/repository.js";

const deletionAudit = {
  deletedAt: null,
  deletedBy: null,
  deleteReason: null,
};

const account: CreditAccount = {
  id: "a1",
  siteId: "s1",
  ownerKind: "user",
  ownerId: "u1",
  status: "active",
  balanceMicros: "0",
  heldMicros: "0",
  ...deletionAudit,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const pricingRule: PricingRule = {
  id: "pr1",
  featureKey: "model.call",
  labelKey: null,
  unit: "token",
  amountMicros: "1",
  status: "active",
  effectiveFrom: new Date(0),
  effectiveUntil: null,
  ...deletionAudit,
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
  featureKey: null,
  labelKey: null,
  modelBindingId: null,
  requestId: null,
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
    sweepExpiredHolds: async () => {
      calls.push("sweepExpiredHolds");
      return 0;
    },
    getHoldById: async () => {
      calls.push("getHoldById");
      return hold;
    },
    priceUsage: async () => {
      calls.push("priceUsage");
      return "1";
    },
    deleteAccount: async (input: DeleteInput) => {
      calls.push("deleteAccount");
      return { ...account, id: input.id, deletedAt: new Date(1), deletedBy: input.deletedBy, deleteReason: input.reason ?? null };
    },
    restoreAccount: async (input: RestoreInput) => {
      calls.push("restoreAccount");
      return { ...account, id: input.id };
    },
    deletePricingRule: async (input: DeleteInput) => {
      calls.push("deletePricingRule");
      return {
        ...pricingRule,
        id: input.id,
        deletedAt: new Date(1),
        deletedBy: input.deletedBy,
        deleteReason: input.reason ?? null,
      };
    },
    restorePricingRule: async (input: RestoreInput) => {
      calls.push("restorePricingRule");
      return { ...pricingRule, id: input.id };
    },
    createPricingRule: async (input) => {
      calls.push("createPricingRule");
      return {
        ...pricingRule,
        ...input,
        labelKey: input.labelKey ?? null,
        status: input.status ?? "active",
        effectiveFrom: input.effectiveFrom ?? new Date(0),
        effectiveUntil: input.effectiveUntil ?? null,
      };
    },
    quote: async (input) => {
      calls.push("quote");
      quoteInputs.push(input);
      return quoteResult;
    },
    listAccounts: async () => {
      calls.push("listAccounts");
      return [];
    },
    listLedgerEntries: async () => {
      calls.push("listLedgerEntries");
      return [];
    },
    listUsageRecords: async () => {
      calls.push("listUsageRecords");
      return [];
    },
    listPricingRules: async () => {
      calls.push("listPricingRules");
      return [];
    },
    getAccountById: async () => {
      calls.push("getAccountById");
      return account;
    },
    findActiveAccountByOwner: async () => {
      calls.push("findActiveAccountByOwner");
      return account;
    },
    listLedgerByAccount: async () => {
      calls.push("listLedgerByAccount");
      return [];
    },
    listLedgerPage: async () => {
      calls.push("listLedgerPage");
      return [];
    },
    listHoldsByAccount: async () => {
      calls.push("listHoldsByAccount");
      return [];
    },
    listUsageByAccount: async () => {
      calls.push("listUsageByAccount");
      return [];
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

  it("rejects a mutation when the active checker reports owner/site inactive", async () => {
    const { repo, calls } = trackingRepo();
    const rejecting: OwnerSiteActiveChecker = {
      async ensureAccountActive() {
        throw new AppError("owner.inactive", 409, "owner disabled");
      },
    };
    const service = new CreditService(repo, rejecting);
    await expect(
      service.spendCredits({ accountId: "a1", amountMicros: "100", idempotencyKey: "k1", reason: "model_call" }),
    ).rejects.toMatchObject({ code: "owner.inactive", httpStatus: 409 });
    expect(calls).not.toContain("spendCredits");
  });

  it("rejects a mutation when the account does not exist (404)", async () => {
    const { repo } = trackingRepo();
    const service = new CreditService({ ...repo, getAccountById: async () => null });
    await expect(
      service.spendCredits({ accountId: "nope", amountMicros: "100", idempotencyKey: "k1", reason: "model_call" }),
    ).rejects.toMatchObject({ code: "resource.not_found", httpStatus: 404 });
  });

  it.each(["grantCredits", "spendCredits", "holdCredits"] as const)(
    "%s rejects a deleted account before mutating",
    async (method) => {
      const { repo, calls } = trackingRepo();
      const service = new CreditService({
        ...repo,
        getAccountById: async () => ({ ...account, deletedAt: new Date(1), deletedBy: "operator", deleteReason: "closed" }),
      });

      if (method === "holdCredits") {
        await expect(
          service.holdCredits({ accountId: "a1", amountMicros: "100", idempotencyKey: "hold_deleted" }),
        ).rejects.toMatchObject({ code: "credit.account.deleted" });
      } else {
        await expect(
          service[method]({
            accountId: "a1",
            amountMicros: "100",
            idempotencyKey: `${method}_deleted`,
            reason: method === "grantCredits" ? "manual_adjustment" : "model_call",
          }),
        ).rejects.toMatchObject({ code: "credit.account.deleted" });
      }

      expect(calls).not.toContain(method);
    },
  );

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
    // holdCredits 前置 getAccountById（owner/site guard）；capture/release 走 holdId 不重复校验。
    expect(calls).toEqual(["getAccountById", "holdCredits", "captureHold", "releaseHold"]);
  });

  it("delegates sweepExpiredHolds to repository and returns the reclaimed count", async () => {
    const { repo } = trackingRepo();
    const service = new CreditService({ ...repo, sweepExpiredHolds: async () => 4 });
    expect(await service.sweepExpiredHolds()).toBe(4);
  });

  it("delegates ensureAccount to repository", async () => {
    const { repo, calls } = trackingRepo();
    const service = new CreditService(repo);
    await service.ensureAccount({ siteId: "s1", ownerKind: "user", ownerId: "u1" });
    expect(calls).toContain("ensureAccount");
  });

  it("rejects ensureAccount before repository when owner/site is inactive", async () => {
    const { repo, calls } = trackingRepo();
    const rejecting: OwnerSiteActiveChecker = {
      async ensureAccountActive() {
        throw new AppError("owner.inactive", 409, "owner disabled");
      },
    };
    const service = new CreditService(repo, rejecting);

    await expect(service.ensureAccount({ siteId: "s1", ownerKind: "user", ownerId: "u1" })).rejects.toMatchObject({
      code: "owner.inactive",
      httpStatus: 409,
    });
    expect(calls).not.toContain("ensureAccount");
  });

  it("delegates account and pricing lifecycle methods", async () => {
    const { repo, calls } = trackingRepo();
    const service = new CreditService(repo);

    await service.deleteAccount({ id: "a1", deletedBy: "operator", reason: "closed" });
    await service.restoreAccount({ id: "a1" });
    await service.createPricingRule({ featureKey: "model.call", unit: "token", amountMicros: "1" });
    await service.deletePricingRule({ id: "pr1", deletedBy: "operator" });
    await service.restorePricingRule({ id: "pr1" });

    expect(calls).toEqual([
      "deleteAccount",
      "restoreAccount",
      "createPricingRule",
      "deletePricingRule",
      "restorePricingRule",
    ]);
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
