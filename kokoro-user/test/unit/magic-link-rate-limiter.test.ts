import { describe, expect, it, vi } from "vitest";
import {
  InMemoryMagicLinkRateLimiter,
  RedisMagicLinkRateLimiter,
  type RateLimitRedis,
} from "../../src/application/magic-link-rate-limiter.js";

const t0 = new Date("2026-07-13T00:00:00.000Z");

describe("InMemoryMagicLinkRateLimiter", () => {
  it("allows up to max per email in a window, then blocks, then recovers", async () => {
    const rl = new InMemoryMagicLinkRateLimiter({ max: 2, ipMax: 2, windowSeconds: 600 });
    const dim = { email: "burst@example.com" };

    expect(await rl.consume(dim, t0)).toBe(true);
    expect(await rl.consume(dim, t0)).toBe(true);
    expect(await rl.consume(dim, t0)).toBe(false);

    // 另一邮箱不受影响。
    expect(await rl.consume({ email: "other@example.com" }, t0)).toBe(true);

    // 窗口滚过后恢复。
    const later = new Date(t0.getTime() + 600_000);
    expect(await rl.consume(dim, later)).toBe(true);
  });

  it("blocks when the ip dimension is over the limit even if the email is fresh", async () => {
    const rl = new InMemoryMagicLinkRateLimiter({ max: 2, ipMax: 2, windowSeconds: 600 });
    // 同 IP 两次不同邮箱耗尽 IP 配额。
    expect(await rl.consume({ email: "a@example.com", ip: "1.2.3.4" }, t0)).toBe(true);
    expect(await rl.consume({ email: "b@example.com", ip: "1.2.3.4" }, t0)).toBe(true);
    // 第三个不同邮箱、同 IP → IP 维超限即拒。
    expect(await rl.consume({ email: "c@example.com", ip: "1.2.3.4" }, t0)).toBe(false);
    // 换 IP 放行。
    expect(await rl.consume({ email: "c@example.com", ip: "5.6.7.8" }, t0)).toBe(true);
  });
});

describe("RedisMagicLinkRateLimiter", () => {
  function fakeRedis(): { redis: RateLimitRedis; counts: Map<string, number>; expires: string[] } {
    const counts = new Map<string, number>();
    const expires: string[] = [];
    const redis: RateLimitRedis = {
      incr: async (key) => {
        const next = (counts.get(key) ?? 0) + 1;
        counts.set(key, next);
        return next;
      },
      expire: async (key) => {
        expires.push(key);
        return 1;
      },
    };
    return { redis, counts, expires };
  }

  it("sets a TTL on first hit and blocks once the count exceeds max", async () => {
    const { redis, expires } = fakeRedis();
    const rl = new RedisMagicLinkRateLimiter(redis, { max: 2, ipMax: 20, windowSeconds: 600 });
    const dim = { email: "burst@example.com" };

    expect(await rl.consume(dim, t0)).toBe(true);
    expect(await rl.consume(dim, t0)).toBe(true);
    expect(await rl.consume(dim, t0)).toBe(false);
    // 只在计数命中 1 时设 TTL。
    expect(expires).toHaveLength(1);
  });

  it("scopes the window key by floor(now / window) so a new window resets", async () => {
    const { redis } = fakeRedis();
    const rl = new RedisMagicLinkRateLimiter(redis, { max: 1, ipMax: 10, windowSeconds: 600 });
    const dim = { email: "u@example.com" };
    expect(await rl.consume(dim, t0)).toBe(true);
    expect(await rl.consume(dim, t0)).toBe(false);
    // 下一窗口键不同 → 重新放行。
    expect(await rl.consume(dim, new Date(t0.getTime() + 600_000))).toBe(true);
  });

  it("fails open with a WARN when redis throws (availability over throttling)", async () => {
    const warn = vi.fn();
    const redis: RateLimitRedis = {
      incr: async () => {
        throw new Error("connection refused");
      },
      expire: async () => 1,
    };
    const rl = new RedisMagicLinkRateLimiter(redis, { max: 1, ipMax: 10, windowSeconds: 600 }, { warn });

    expect(await rl.consume({ email: "u@example.com" }, t0)).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
  });
});
