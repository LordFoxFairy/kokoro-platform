import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { CreditService } from "../../src/application/credit-service.js";
import type { CreditAccount } from "../../src/domain/credit.js";
import type { CreditRepository, EnsureCreditAccountInput } from "../../src/domain/repository.js";
import { registerCreditRoutes } from "../../src/interfaces/http/routes.js";

function ensureOnlyRepo(seen: EnsureCreditAccountInput[]): CreditRepository {
  const reject = () => Promise.reject(new Error("not implemented"));
  return {
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
        deletedAt: null,
        deletedBy: null,
        deleteReason: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      };
      return account;
    },
    grantCredits: reject,
    spendCredits: reject,
    holdCredits: reject,
    captureHold: reject,
    releaseHold: reject,
    getHoldById: reject,
    priceUsage: reject,
    deleteAccount: reject,
    restoreAccount: reject,
    createPricingRule: reject,
    deletePricingRule: reject,
    restorePricingRule: reject,
    quote: reject,
    listAccounts: reject,
    listLedgerEntries: reject,
    listUsageRecords: reject,
    listPricingRules: reject,
    getAccountById: reject,
    listLedgerByAccount: reject,
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
