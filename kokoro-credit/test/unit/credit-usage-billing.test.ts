import { describe, expect, it } from "vitest";
import { AppError } from "@kokoro/platform-kit";
import {
  CreditService,
  DEFAULT_RUN_BILLING_CONFIG,
  type RunBillingConfig,
} from "../../src/application/credit-service.js";
import type { CreditAccount, CreditHold, CreditMutationResult } from "../../src/domain/credit.js";
import {
  CreditAccountNotFoundError,
  CreditHoldNotFoundError,
  QuotaExceededError,
} from "../../src/domain/errors.js";
import type {
  CaptureCreditInput,
  CreditRepository,
  HoldCreditInput,
  PriceUsageInput,
  ReleaseCreditInput,
} from "../../src/domain/repository.js";

const account: CreditAccount = {
  id: "a1",
  siteId: "s1",
  ownerKind: "team",
  ownerId: "team_ns",
  status: "active",
  balanceMicros: "1000000",
  heldMicros: "0",
  dailyMicros: "0",
  dailyResetOn: null,
  periodMicros: "0",
  periodResetOn: null,
  quotaMicros: null,
  quotaPeriod: null,
  deletedAt: null,
  deletedBy: null,
  deleteReason: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

function usageHold(overrides: Partial<CreditHold> = {}): CreditHold {
  return {
    id: "h1",
    accountId: "a1",
    amountMicros: "9600",
    status: "active",
    idempotencyKey: "run_1",
    expiresAt: null,
    featureKey: "model.run",
    labelKey: "gpt-4",
    modelBindingId: "binding_1",
    requestId: "run_1",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function captureResult(amountMicros: string): CreditMutationResult {
  return {
    account,
    entry: {
      id: "e1",
      accountId: "a1",
      amountMicros: `-${amountMicros}`,
      balanceAfterMicros: "0",
      reason: "model_call",
      idempotencyKey: "run_1",
      requestId: "run_1",
      createdAt: new Date(0),
    },
  };
}

const rejectRepo: CreditRepository = new Proxy({} as CreditRepository, {
  get() {
    return async () => {
      throw new Error("unexpected repository call");
    };
  },
});

function serviceWith(overrides: Partial<CreditRepository>, config: RunBillingConfig = DEFAULT_RUN_BILLING_CONFIG) {
  const repo = { ...rejectRepo, ...overrides } as CreditRepository;
  return new CreditService(repo, undefined, config);
}

describe("holdForUsage", () => {
  it("resolves namespace to a team account and holds pricing × est × buffer", async () => {
    const holdInputs: HoldCreditInput[] = [];
    const priceInputs: PriceUsageInput[] = [];
    const service = serviceWith({
      ensureAccount: async () => ({ account, created: false }),
      priceUsage: async (input) => {
        priceInputs.push(input);
        return "8000";
      },
      holdCredits: async (input) => {
        holdInputs.push(input);
        return usageHold({ id: "h9", amountMicros: input.amountMicros });
      },
    });

    const result = await service.holdForUsage({
      siteId: "s1",
      namespace: "team_ns",
      featureKey: "model.run",
      labelKey: "gpt-4",
      idempotencyKey: "run_1",
      modelBindingId: "binding_1",
      requestId: "run_1",
    });

    // 8000 × (100+20)/100 = 9600 micros → 向上取整到整积分 = 10000（1 积分）
    expect(result.amountMicros).toBe("10000");
    expect(result.holdId).toBe("h9");
    expect(holdInputs[0]).toMatchObject({
      amountMicros: "10000",
      featureKey: "model.run",
      labelKey: "gpt-4",
      modelBindingId: "binding_1",
      requestId: "run_1",
    });
    expect(priceInputs[0]).toMatchObject({
      inputUnit: "input_token",
      outputUnit: "output_token",
      inputTokens: "1000",
      outputTokens: "1000",
    });
  });

  it("floors the hold to 1 credit (min charge) when the estimate prices to zero", async () => {
    const holdInputs: HoldCreditInput[] = [];
    const service = serviceWith(
      {
        ensureAccount: async () => ({ account, created: false }),
        priceUsage: async () => "0",
        holdCredits: async (input) => {
          holdInputs.push(input);
          return usageHold({ amountMicros: input.amountMicros });
        },
      },
      { ...DEFAULT_RUN_BILLING_CONFIG, estInputTokens: "0", estOutputTokens: "0" },
    );

    const result = await service.holdForUsage({
      siteId: "s1",
      namespace: "team_ns",
      featureKey: "model.run",
      idempotencyKey: "run_1",
    });

    expect(result.amountMicros).toBe("10000");
    expect(holdInputs[0]).toMatchObject({ amountMicros: "10000" });
  });
});

describe("settleUsage", () => {
  it("captures the actual cost when it is below the hold", async () => {
    const captureInputs: CaptureCreditInput[] = [];
    const service = serviceWith({
      getHoldById: async () => usageHold({ amountMicros: "30000" }),
      priceUsage: async () => "2200",
      captureHold: async (input) => {
        captureInputs.push(input);
        return captureResult(input.actualAmountMicros);
      },
    });

    const result = await service.settleUsage({
      holdId: "h1",
      inputTokens: "500",
      outputTokens: "200",
      idempotencyKey: "run_1",
    });

    // 实额 2200 micros → 向上取整 1 积分 = 10000（< 冻结 30000，不被 clamp）
    expect(result.outcome).toBe("captured");
    expect(result.amountMicros).toBe("10000");
    expect(captureInputs[0]).toMatchObject({
      actualAmountMicros: "10000",
      reason: "model_call",
      featureKey: "model.run",
      modelBindingId: "binding_1",
      requestId: "run_1",
    });
  });

  it("clamps the capture to the hold amount when actual exceeds it", async () => {
    const captureInputs: CaptureCreditInput[] = [];
    const service = serviceWith({
      getHoldById: async () => usageHold({ amountMicros: "9600" }),
      priceUsage: async () => "800000",
      captureHold: async (input) => {
        captureInputs.push(input);
        return captureResult(input.actualAmountMicros);
      },
    });

    const result = await service.settleUsage({
      holdId: "h1",
      inputTokens: "100000",
      outputTokens: "100000",
      idempotencyKey: "run_1",
    });

    expect(captureInputs[0]).toMatchObject({ actualAmountMicros: "9600" });
    expect(result.amountMicros).toBe("9600");
  });

  it("releases the hold without charging when actual prices to zero", async () => {
    const releaseInputs: ReleaseCreditInput[] = [];
    const service = serviceWith({
      getHoldById: async () => usageHold(),
      priceUsage: async () => "0",
      releaseHold: async (input) => {
        releaseInputs.push(input);
        return usageHold({ status: "released" });
      },
      getAccountById: async () => account,
    });

    const result = await service.settleUsage({
      holdId: "h1",
      inputTokens: "0",
      outputTokens: "0",
      idempotencyKey: "run_1",
    });

    expect(result.outcome).toBe("released");
    expect(result.amountMicros).toBe("0");
    expect(releaseInputs[0]).toEqual({ holdId: "h1", idempotencyKey: "run_1" });
  });

  it("throws CreditHoldNotFoundError for an unknown hold", async () => {
    const service = serviceWith({ getHoldById: async () => null });
    await expect(
      service.settleUsage({ holdId: "missing", inputTokens: "1", outputTokens: "1", idempotencyKey: "run_1" }),
    ).rejects.toBeInstanceOf(CreditHoldNotFoundError);
  });

  it("rejects settling a hold without a pricing ref (409)", async () => {
    const service = serviceWith({ getHoldById: async () => usageHold({ featureKey: null }) });
    await expect(
      service.settleUsage({ holdId: "h1", inputTokens: "1", outputTokens: "1", idempotencyKey: "run_1" }),
    ).rejects.toMatchObject({ code: "credit.hold_not_usage_metered", httpStatus: 409 });
  });

  it("surfaces a missing account after release as CreditAccountNotFoundError", async () => {
    const service = serviceWith({
      getHoldById: async () => usageHold(),
      priceUsage: async () => "0",
      releaseHold: async () => usageHold({ status: "released" }),
      getAccountById: async () => null,
    });
    await expect(
      service.settleUsage({ holdId: "h1", inputTokens: "0", outputTokens: "0", idempotencyKey: "run_1" }),
    ).rejects.toBeInstanceOf(CreditAccountNotFoundError);
  });

  it("still returns an AppError instance for the not-usage-metered case", async () => {
    const service = serviceWith({ getHoldById: async () => usageHold({ featureKey: null }) });
    const error = await service.settleUsage({ holdId: "h1", inputTokens: "1", outputTokens: "1", idempotencyKey: "run_1" }).catch((e) => e);
    expect(error).toBeInstanceOf(AppError);
  });
});

describe("holdForUsage organisation quota gate", () => {
  const quotaAccount = { ...account, quotaMicros: "10000", quotaPeriod: "monthly" as const };

  function usageCommand() {
    return {
      siteId: "s1",
      namespace: "team_ns",
      featureKey: "model.run",
      labelKey: "gpt-4",
      idempotencyKey: "run_1",
    };
  }

  it("does not query period usage when the account has no quota (unset = unlimited)", async () => {
    let sumCalled = false;
    const service = serviceWith({
      ensureAccount: async () => ({ account, created: false }), // quotaMicros=null
      priceUsage: async () => "8000",
      sumCapturedUsageSince: async () => {
        sumCalled = true;
        return "0";
      },
      holdCredits: async (input) => usageHold({ amountMicros: input.amountMicros }),
    });
    await service.holdForUsage(usageCommand());
    expect(sumCalled).toBe(false);
  });

  it("holds when settled + held + incoming stays within the quota", async () => {
    // quota 10000；本次冻结 8000×1.2=9600 → 向上取整整积分 = 10000。已结算 0 + 在持 0 + 10000 = 10000，不超上限 → 放行。
    const service = serviceWith({
      ensureAccount: async () => ({ account: quotaAccount, created: false }),
      priceUsage: async () => "8000",
      sumCapturedUsageSince: async () => "0",
      holdCredits: async (input) => usageHold({ amountMicros: input.amountMicros }),
    });
    const result = await service.holdForUsage(usageCommand());
    expect(result.amountMicros).toBe("10000");
  });

  it("rejects with QuotaExceededError when settled + held + incoming exceeds the quota", async () => {
    // settled=1000 + held(account.heldMicros=0) + incoming 9600 = 10600 > 10000 → 拒。
    const service = serviceWith({
      ensureAccount: async () => ({ account: quotaAccount, created: false }),
      priceUsage: async () => "8000",
      sumCapturedUsageSince: async () => "1000",
      holdCredits: async () => {
        throw new Error("hold should never run once quota is exceeded");
      },
    });
    await expect(service.holdForUsage(usageCommand())).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it("counts in-flight holds toward the quota (settle clamp keeps them from double-counting)", async () => {
    // heldMicros=5000（在持）+ settled 0 + incoming 9600 = 14600 > 10000 → 拒（在持 hold 计入本周期）。
    const service = serviceWith({
      ensureAccount: async () => ({ account: { ...quotaAccount, heldMicros: "5000" }, created: false }),
      priceUsage: async () => "8000",
      sumCapturedUsageSince: async () => "0",
      holdCredits: async () => {
        throw new Error("hold should never run once quota is exceeded");
      },
    });
    await expect(service.holdForUsage(usageCommand())).rejects.toBeInstanceOf(QuotaExceededError);
  });
});
