import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { CreditService } from "../../src/application/credit-service.js";
import type { CreditAccount, CreditLedgerEntry } from "../../src/domain/credit.js";
import type { CreditRepository, EnsureCreditAccountInput } from "../../src/domain/repository.js";
import { registerCreditRoutes } from "../../src/interfaces/http/routes.js";

const NS = "ns-team-1";

function account(): CreditAccount {
  return {
    id: "acc_1",
    siteId: "site-a",
    ownerKind: "team",
    ownerId: NS,
    status: "active",
    balanceMicros: "95000000",
    heldMicros: "250000",
    deletedAt: null,
    deletedBy: null,
    deleteReason: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

// 三条流水（createdAt desc、id desc 稳定序）：capture 带 requestId=run_id、grant 无 requestId。
function ledger(): CreditLedgerEntry[] {
  return [
    {
      id: "e3",
      accountId: "acc_1",
      amountMicros: "-3000000",
      balanceAfterMicros: "95000000",
      reason: "model_call",
      idempotencyKey: "run_z",
      requestId: "run_z",
      createdAt: new Date("2026-01-01T00:00:03.000Z"),
    },
    {
      id: "e2",
      accountId: "acc_1",
      amountMicros: "-2000000",
      balanceAfterMicros: "98000000",
      reason: "model_call",
      idempotencyKey: "run_y",
      requestId: "run_y",
      createdAt: new Date("2026-01-01T00:00:02.000Z"),
    },
    {
      id: "e1",
      accountId: "acc_1",
      amountMicros: "100000000",
      balanceAfterMicros: "100000000",
      reason: "manual_adjustment",
      idempotencyKey: "grant_1",
      requestId: null,
      createdAt: new Date("2026-01-01T00:00:01.000Z"),
    },
  ];
}

// 只读面 repo 双：仅 findActiveAccountByOwner + listLedgerPage 落地，其余编排面 reject。
function readRepo(hasAccount: boolean): CreditRepository {
  const reject = () => Promise.reject(new Error("not implemented"));
  const rows = ledger();
  return {
    async findActiveAccountByOwner(input: EnsureCreditAccountInput) {
      return hasAccount && input.ownerId === NS ? account() : null;
    },
    async listLedgerPage(_accountId, opts) {
      // createdAt desc、id desc 稳定序 + 复合游标：严格晚于（更旧于）游标位。
      const sorted = [...rows].sort((a, b) =>
        a.createdAt.getTime() === b.createdAt.getTime()
          ? b.id.localeCompare(a.id)
          : b.createdAt.getTime() - a.createdAt.getTime(),
      );
      const cursor = opts.cursor;
      const filtered =
        cursor === undefined
          ? sorted
          : sorted.filter(
              (r) =>
                r.createdAt.getTime() < cursor.createdAt.getTime() ||
                (r.createdAt.getTime() === cursor.createdAt.getTime() && r.id < cursor.id),
            );
      return filtered.slice(0, opts.limit);
    },
    ensureAccount: reject,
    grantCredits: reject,
    spendCredits: reject,
    holdCredits: reject,
    captureHold: reject,
    releaseHold: reject,
    sweepExpiredHolds: reject,
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

function buildApp(hasAccount: boolean) {
  const app = Fastify({ logger: false });
  registerCreditRoutes(app, new CreditService(readRepo(hasAccount)));
  return app;
}

const SITE = { "x-kokoro-site-id": "site-a" };

describe("GET /credit/usage/summary", () => {
  it("缺站点上下文 → 400 credit.site_required", async () => {
    const res = await buildApp(true).inject({ method: "GET", url: "/credit/usage/summary?namespace=" + NS });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("credit.site_required");
  });

  it("无账户（只读不建账）→ 零额", async () => {
    const res = await buildApp(false).inject({
      method: "GET",
      url: "/credit/usage/summary?namespace=" + NS,
      headers: SITE,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ balanceMicros: "0", heldMicros: "0" });
  });

  it("有账户 → 余额 + held 聚合微单位字符串直透", async () => {
    const res = await buildApp(true).inject({
      method: "GET",
      url: "/credit/usage/summary?namespace=" + NS,
      headers: SITE,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ balanceMicros: "95000000", heldMicros: "250000" });
  });
});

describe("GET /credit/usage/ledger", () => {
  it("无账户 → 空流水", async () => {
    const res = await buildApp(false).inject({
      method: "GET",
      url: "/credit/usage/ledger?namespace=" + NS,
      headers: SITE,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ entries: [] });
  });

  it("复合游标分页 + run_id 由 requestId 回填（null 则为 null）", async () => {
    const page1 = await buildApp(true).inject({
      method: "GET",
      url: `/credit/usage/ledger?namespace=${NS}&limit=2`,
      headers: SITE,
    });
    expect(page1.statusCode).toBe(200);
    const d1 = page1.json().data;
    expect(d1.entries.map((e: { entryId: string }) => e.entryId)).toEqual(["e3", "e2"]);
    // 映射形状：微单位含符号直透、createdAt→epoch ms、runId=requestId。
    expect(d1.entries[0]).toEqual({
      entryId: "e3",
      deltaMicros: "-3000000",
      reason: "model_call",
      createdAt: new Date("2026-01-01T00:00:03.000Z").getTime(),
      runId: "run_z",
    });
    expect(typeof d1.nextCursor).toBe("string");

    // 续页：末条含 requestId=null 的 grant 行 → runId=null。
    const page2 = await buildApp(true).inject({
      method: "GET",
      url: `/credit/usage/ledger?namespace=${NS}&limit=2&cursor=${encodeURIComponent(d1.nextCursor)}`,
      headers: SITE,
    });
    const d2 = page2.json().data;
    expect(d2.entries.map((e: { entryId: string }) => e.entryId)).toEqual(["e1"]);
    expect(d2.entries[0].runId).toBeNull();
    expect(d2.nextCursor).toBeUndefined();
  });

  it("非法游标 → 400 credit.invalid_cursor", async () => {
    const res = await buildApp(true).inject({
      method: "GET",
      url: `/credit/usage/ledger?namespace=${NS}&cursor=%20`,
      headers: SITE,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("credit.invalid_cursor");
  });
});
