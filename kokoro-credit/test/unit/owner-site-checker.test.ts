import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpOwnerSiteChecker } from "../../src/infrastructure/http/owner-site-checker.js";
import type { CreditAccount } from "../../src/domain/credit.js";

const account: CreditAccount = {
  id: "a1",
  siteId: "s1",
  ownerKind: "user",
  ownerId: "u1",
  status: "active",
  balanceMicros: "0",
  heldMicros: "0",
  quotaMicros: null,
  quotaPeriod: null,
  deletedAt: null,
  deletedBy: null,
  deleteReason: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

function fetchReturning(activeFor: (url: string) => boolean): typeof fetch {
  return async (url) =>
    new Response(JSON.stringify({ data: { active: activeFor(String(url)) } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

describe("HttpOwnerSiteChecker", () => {
  it("passes when both site and owner are active", async () => {
    const checker = new HttpOwnerSiteChecker("http://user", "http://site", "sec", fetchReturning(() => true));
    await expect(checker.ensureAccountActive(account)).resolves.toBeUndefined();
  });

  it("throws site.suspended when the site is inactive", async () => {
    const checker = new HttpOwnerSiteChecker(
      "http://user",
      "http://site",
      "sec",
      fetchReturning((url) => !url.includes("/sites/")),
    );
    await expect(checker.ensureAccountActive(account)).rejects.toMatchObject({
      code: "site.suspended",
      httpStatus: 409,
    });
  });

  it("throws owner.inactive when the owner is inactive", async () => {
    const checker = new HttpOwnerSiteChecker(
      "http://user",
      "http://site",
      "sec",
      fetchReturning((url) => url.includes("/sites/")),
    );
    await expect(checker.ensureAccountActive(account)).rejects.toMatchObject({
      code: "owner.inactive",
      httpStatus: 409,
    });
  });
});

// 可变后端 + 计数 spy：按 URL 前缀区分 site/owner 查询，供缓存行为断言。
function countingFetch(activeFor: (url: string) => boolean) {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    return new Response(JSON.stringify({ data: { active: activeFor(u) } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, calls };
}

const cacheOpts = { ttlMs: 30_000, maxEntries: 100 };

describe("HttpOwnerSiteChecker active cache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("serves repeat checks from cache with zero outbound calls", async () => {
    const { fetchImpl, calls } = countingFetch(() => true);
    const checker = new HttpOwnerSiteChecker("http://user", "http://site", "sec", fetchImpl, cacheOpts);
    await checker.ensureAccountActive(account);
    expect(calls).toHaveLength(2);
    await checker.ensureAccountActive(account);
    await checker.ensureAccountActive(account);
    expect(calls).toHaveLength(2);
  });

  it("re-queries after the TTL expires", async () => {
    vi.useFakeTimers();
    const { fetchImpl, calls } = countingFetch(() => true);
    const checker = new HttpOwnerSiteChecker("http://user", "http://site", "sec", fetchImpl, cacheOpts);
    await checker.ensureAccountActive(account);
    expect(calls).toHaveLength(2);
    vi.advanceTimersByTime(cacheOpts.ttlMs - 1);
    await checker.ensureAccountActive(account);
    expect(calls).toHaveLength(2);
    vi.advanceTimersByTime(2);
    await checker.ensureAccountActive(account);
    expect(calls).toHaveLength(4);
  });

  it("does not cache inactive results: flipping back to active takes effect immediately", async () => {
    let ownerActive = false;
    const { fetchImpl, calls } = countingFetch((url) => (url.includes("/owners/") ? ownerActive : true));
    const checker = new HttpOwnerSiteChecker("http://user", "http://site", "sec", fetchImpl, cacheOpts);
    await expect(checker.ensureAccountActive(account)).rejects.toMatchObject({ code: "owner.inactive" });
    expect(calls).toHaveLength(2);
    ownerActive = true;
    await expect(checker.ensureAccountActive(account)).resolves.toBeUndefined();
    // site 已正向缓存，只补 owner 一次出站
    expect(calls).toHaveLength(3);
  });

  it("does not cache an unreachable backend", async () => {
    let broken = true;
    const okFetch = countingFetch(() => true);
    const fetchImpl: typeof fetch = async (url, init) => {
      if (broken) throw new Error("connect ECONNREFUSED");
      return okFetch.fetchImpl(url, init);
    };
    const checker = new HttpOwnerSiteChecker("http://user", "http://site", "sec", fetchImpl, cacheOpts);
    await expect(checker.ensureAccountActive(account)).rejects.toBeTruthy();
    broken = false;
    await expect(checker.ensureAccountActive(account)).resolves.toBeUndefined();
    expect(okFetch.calls).toHaveLength(2);
  });

  it("does not leak the site cache across sites", async () => {
    const { fetchImpl, calls } = countingFetch((url) => !url.includes("/sites/s2/"));
    const checker = new HttpOwnerSiteChecker("http://user", "http://site", "sec", fetchImpl, cacheOpts);
    await checker.ensureAccountActive(account);
    expect(calls).toHaveLength(2);
    // 同 owner、另一个 site：site 必须重新出站查询，s2 suspended 必须命中 409
    await expect(checker.ensureAccountActive({ ...account, siteId: "s2" })).rejects.toMatchObject({
      code: "site.suspended",
      httpStatus: 409,
    });
    expect(calls).toHaveLength(3);
    expect(calls[2]).toContain("/sites/s2/");
  });

  it("does not leak the owner cache across sites: same owner re-verified per site (纲领 §8.2-4)", async () => {
    // owner active 随出站次数翻转：site A 出站得 active（暖缓存），site B 出站得 inactive。
    let ownerActive = true;
    const { fetchImpl, calls } = countingFetch((url) => (url.includes("/owners/") ? ownerActive : true));
    const checker = new HttpOwnerSiteChecker("http://user", "http://site", "sec", fetchImpl, cacheOpts);
    const teamAccount = { ...account, siteId: "sA", ownerKind: "team" as const, ownerId: "X" };

    // site A：(team,X) active → 暖 site+owner 缓存
    await checker.ensureAccountActive(teamAccount);
    expect(calls).toHaveLength(2);

    // site B 同 (team,X)：owner 在 B 站语境 inactive → 必须重新出站并按 B 站结果裁决，不吃 A 站缓存
    ownerActive = false;
    await expect(checker.ensureAccountActive({ ...teamAccount, siteId: "sB" })).rejects.toMatchObject({
      code: "owner.inactive",
      httpStatus: 409,
    });
    // fetch spy：site(sB) + owner(sB) 二次出站；owner 共两次，B 站结果未被 A 站缓存串走
    expect(calls).toHaveLength(4);
    expect(calls.filter((u) => u.includes("/owners/"))).toHaveLength(2);
  });

  it("evicts oldest entries beyond maxEntries instead of growing unbounded", async () => {
    const { fetchImpl, calls } = countingFetch(() => true);
    const checker = new HttpOwnerSiteChecker("http://user", "http://site", "sec", fetchImpl, {
      ttlMs: 30_000,
      maxEntries: 2,
    });
    await checker.ensureAccountActive({ ...account, siteId: "s1" });
    await checker.ensureAccountActive({ ...account, siteId: "s2" });
    await checker.ensureAccountActive({ ...account, siteId: "s3" });
    const before = calls.length;
    // s1 的 site 与 owner 条目均已被逐出（owner 现按 site 维度缓存，随 site 一起淘汰）→ 两者都重新出站
    await checker.ensureAccountActive({ ...account, siteId: "s1" });
    expect(calls.length).toBe(before + 2);
    expect(calls[calls.length - 2]).toContain("/sites/s1/");
    expect(calls[calls.length - 1]).toContain("/owners/");
  });

  it("bypasses the cache entirely when ttlMs is 0", async () => {
    const { fetchImpl, calls } = countingFetch(() => true);
    const checker = new HttpOwnerSiteChecker("http://user", "http://site", "sec", fetchImpl, {
      ttlMs: 0,
      maxEntries: 100,
    });
    await checker.ensureAccountActive(account);
    await checker.ensureAccountActive(account);
    expect(calls).toHaveLength(4);
  });
});
