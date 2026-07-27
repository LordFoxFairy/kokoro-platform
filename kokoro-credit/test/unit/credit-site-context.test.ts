import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { CreditService } from "../../src/application/credit-service.js";
import type { CreditAccount, CreditHold, CreditMutationResult } from "../../src/domain/credit.js";
import type { CreditRepository, EnsureCreditAccountInput } from "../../src/domain/repository.js";
import { registerCreditRoutes } from "../../src/interfaces/http/routes.js";

function ensureOnlyRepo(seen: EnsureCreditAccountInput[]): CreditRepository {
  const reject = () => Promise.reject(new Error("not implemented"));
  return {
    refreshAllowances: reject,
    ensureAccount: async (input) => {
      seen.push(input);
      const account: CreditAccount = {
        id: "a1",
        siteId: input.siteId,
        ownerKind: input.ownerKind,
        ownerId: input.ownerId,
        status: "active",
        balanceMicros: "0",
        heldMicros: "0",
        dailyMicros: "0",
        dailyResetOn: null,
        periodMicros: "0",
        periodResetOn: null,
        dailyAllowanceMicros: "0",
        periodAllowanceMicros: "0",
        quotaMicros: null,
        quotaPeriod: null,
        deletedAt: null,
        deletedBy: null,
        deleteReason: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      };
      return { account, created: false };
    },
    grantCredits: reject,
    spendCredits: reject,
    resetBalance: reject,
    holdCredits: reject,
    captureHold: reject,
    releaseHold: reject,
    sweepExpiredHolds: reject,
    getHoldById: reject,
    priceUsage: reject,
    deleteAccount: reject,
    restoreAccount: reject,
    createPricingRule: reject,
    updatePricingRule: reject,
    deletePricingRule: reject,
    restorePricingRule: reject,
    quote: reject,
    listAccounts: reject,
    readAdminStats: reject,
    listLedgerEntries: reject,
    listUsageRecords: reject,
    listPricingRules: reject,
    getAccountById: reject,
    setAccountQuota: reject,
    sumCapturedUsageSince: reject,
    sumUsageByModelSince: reject,
    findActiveAccountByOwner: reject,
    listLedgerByAccount: reject,
    listLedgerPage: reject,
    listHoldsByAccount: reject,
    listUsageByAccount: reject,
  };
}

function buildApp(seen: EnsureCreditAccountInput[]) {
  const app = Fastify({ logger: false });
  registerCreditRoutes(app, new CreditService(ensureOnlyRepo(seen)));
  return app;
}

describe("POST /credit/accounts/ensure site context", () => {
  const seen: EnsureCreditAccountInput[] = [];
  const app = buildApp(seen);

  afterEach(() => {
    seen.length = 0;
  });

  it("returns 400 credit.site_required when x-kokoro-site-id header is absent", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/credit/accounts/ensure",
      payload: { ownerKind: "user", ownerId: "u1" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("credit.site_required");
    expect(seen).toHaveLength(0);
  });

  it("derives siteId from header (not body) and passes it to the service", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/credit/accounts/ensure",
      headers: { "x-kokoro-site-id": "site-a" },
      payload: { ownerKind: "user", ownerId: "u1" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.siteId).toBe("site-a");
    expect(seen[0]).toEqual({ siteId: "site-a", ownerKind: "user", ownerId: "u1" });
  });

  it("rejects siteId smuggled in the body (schema is strict)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/credit/accounts/ensure",
      headers: { "x-kokoro-site-id": "site-a" },
      payload: { ownerKind: "user", ownerId: "u1", siteId: "site-b" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("request.invalid");
  });
});

// 计费写路由（usage/hold、usage/settle、release）与上面的账户面相反：siteId 由请求体承载且为权威，
// header 只做交叉校验。下面用「repo 是否被调用」证明拒绝发生在触达领域层之前。
const billingAccount: CreditAccount = {
  id: "acc_billing",
  siteId: "site-a",
  ownerKind: "team",
  ownerId: "team_ns",
  status: "active",
  balanceMicros: "1000000",
  heldMicros: "0",
  dailyMicros: "0",
  dailyResetOn: null,
  periodMicros: "0",
  periodResetOn: null,
  dailyAllowanceMicros: "0",
  periodAllowanceMicros: "0",
  quotaMicros: null,
  quotaPeriod: null,
  deletedAt: null,
  deletedBy: null,
  deleteReason: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const billingHold: CreditHold = {
  id: "h1",
  accountId: "acc_billing",
  amountMicros: "30000",
  reservedDailyMicros: "0",
  reservedPeriodMicros: "0",
  reservedPermanentMicros: "30000",
  status: "active",
  idempotencyKey: "run_1",
  expiresAt: null,
  featureKey: "model.run",
  labelKey: "gpt-4",
  modelBindingId: "binding_1",
  requestId: "run_1",
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const captureResult: CreditMutationResult = {
  account: billingAccount,
  entry: {
    id: "e1",
    accountId: "acc_billing",
    amountMicros: "-10000",
    balanceAfterMicros: "990000",
    reason: "model_call",
    idempotencyKey: "run_1",
    requestId: "run_1",
    createdAt: new Date(0),
  },
};

// 记录仓储侧真正被触达的调用；任何未预期的方法直接炸，避免静默走通。
interface BillingProbe {
  ensuredSites: string[];
  touched: string[];
}

function billingRepo(probe: BillingProbe): CreditRepository {
  const stubs: Partial<CreditRepository> = {
    ensureAccount: async (input) => {
      probe.ensuredSites.push(input.siteId);
      probe.touched.push("ensureAccount");
      return { account: { ...billingAccount, siteId: input.siteId }, created: false };
    },
    priceUsage: async () => {
      probe.touched.push("priceUsage");
      return "8000";
    },
    holdCredits: async (input) => {
      probe.touched.push("holdCredits");
      return { ...billingHold, amountMicros: input.amountMicros };
    },
    getHoldById: async () => {
      probe.touched.push("getHoldById");
      return billingHold;
    },
    captureHold: async () => {
      probe.touched.push("captureHold");
      return captureResult;
    },
    releaseHold: async () => {
      probe.touched.push("releaseHold");
      return { ...billingHold, status: "released" };
    },
  };
  return new Proxy(stubs as CreditRepository, {
    get(target, property, receiver) {
      const stub = Reflect.get(target, property, receiver);
      if (stub !== undefined) {
        return stub;
      }
      return async () => {
        throw new Error(`unexpected repository call: ${String(property)}`);
      };
    },
  });
}

function buildBillingApp(probe: BillingProbe) {
  const app = Fastify({ logger: false });
  registerCreditRoutes(app, new CreditService(billingRepo(probe)));
  return app;
}

describe("credit billing write routes take siteId from the body", () => {
  const probe: BillingProbe = { ensuredSites: [], touched: [] };
  const app = buildBillingApp(probe);

  afterEach(() => {
    probe.ensuredSites.length = 0;
    probe.touched.length = 0;
  });

  const holdPayload = {
    siteId: "site-a",
    namespace: "team_ns",
    featureKey: "model.run",
    labelKey: "gpt-4",
    idempotencyKey: "run_1",
  };
  const settlePayload = {
    siteId: "site-a",
    holdId: "h1",
    usage: { inputTokens: 500, outputTokens: 200 },
    idempotencyKey: "run_1",
  };
  const releasePayload = { siteId: "site-a", holdId: "h1", idempotencyKey: "run_1" };

  it("holds using the body siteId when the site header is absent", async () => {
    const response = await app.inject({ method: "POST", url: "/credit/usage/hold", payload: holdPayload });

    expect(response.statusCode).toBe(200);
    // 权威来源是 body：账户按 body 的 siteId 解析，而不是回退到某个 header 默认值。
    expect(probe.ensuredSites).toEqual(["site-a"]);
  });

  it("settles using the body siteId when the site header is absent", async () => {
    const response = await app.inject({ method: "POST", url: "/credit/usage/settle", payload: settlePayload });

    expect(response.statusCode).toBe(200);
    expect(probe.touched).toContain("captureHold");
  });

  it("releases using the body siteId when the site header is absent", async () => {
    const response = await app.inject({ method: "POST", url: "/credit/release", payload: releasePayload });

    expect(response.statusCode).toBe(200);
    expect(probe.touched).toEqual(["releaseHold"]);
  });

  it("accepts a site header that agrees with the body", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/credit/usage/hold",
      headers: { "x-kokoro-site-id": "site-a" },
      payload: holdPayload,
    });

    expect(response.statusCode).toBe(200);
    expect(probe.ensuredSites).toEqual(["site-a"]);
  });

  it.each([
    ["/credit/usage/hold", holdPayload],
    ["/credit/usage/settle", settlePayload],
    ["/credit/release", releasePayload],
  ])("rejects %s when the site header contradicts the body", async (url, payload) => {
    const response = await app.inject({
      method: "POST",
      url,
      headers: { "x-kokoro-site-id": "site-b" },
      payload,
    });

    // 两个站点断言互相矛盾 = confused deputy：不挑一个信，硬拒。
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("credit.site_mismatch");
    expect(probe.touched).toEqual([]);
  });

  it.each([
    ["/credit/usage/hold", holdPayload],
    ["/credit/usage/settle", settlePayload],
    ["/credit/release", releasePayload],
  ])("rejects %s when the body omits siteId (schema requires it)", async (url, payload) => {
    const { siteId: _omitted, ...withoutSiteId } = payload;
    const response = await app.inject({
      method: "POST",
      url,
      headers: { "x-kokoro-site-id": "site-a" },
      payload: withoutSiteId,
    });

    // header 存在也救不了：body 是唯一权威来源，缺失即非法请求，由 schema 在进 handler 前拒掉。
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: "FST_ERR_VALIDATION",
      message: "body must have required property 'siteId'",
    });
    expect(probe.touched).toEqual([]);
  });
});
