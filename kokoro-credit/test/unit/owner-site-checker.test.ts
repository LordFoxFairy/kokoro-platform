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
    // s1 已被逐出 → 重新出站；owner 仍在缓存
    await checker.ensureAccountActive({ ...account, siteId: "s1" });
    expect(calls.length).toBe(before + 1);
    expect(calls[calls.length - 1]).toContain("/sites/s1/");
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
