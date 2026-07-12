import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashMagicLinkToken, MagicLinkService } from "../../src/application/magic-link-service.js";
import {
  MagicLinkInvalidError,
  MagicLinkRateLimitedError,
  magicLinkExternalUserId,
  type IssueMagicLinkInput,
  type MagicLinkRecord,
  type MagicLinkRepository,
} from "../../src/domain/magic-link.js";

const t0 = new Date("2026-07-11T00:00:00.000Z");

function record(overrides: Partial<MagicLinkRecord> = {}): MagicLinkRecord {
  return {
    id: "ml1",
    siteId: "site-a",
    email: "user@example.com",
    tokenHash: "hash",
    nonceHash: null,
    expiresAt: new Date(t0.getTime() + 900_000),
    consumedAt: null,
    supersededAt: null,
    createdAt: t0,
    ...overrides,
  };
}

function fakeRepository(consumeResult: MagicLinkRecord | null = null): {
  repository: MagicLinkRepository;
  issueCalls: IssueMagicLinkInput[];
  consumeCalls: { tokenHash: string; nonceHash: string | null; now: Date }[];
} {
  const issueCalls: IssueMagicLinkInput[] = [];
  const consumeCalls: { tokenHash: string; nonceHash: string | null; now: Date }[] = [];
  const repository: MagicLinkRepository = {
    issue: async (input) => {
      issueCalls.push(input);
      return record({
        tokenHash: input.tokenHash,
        nonceHash: input.nonceHash,
        expiresAt: input.expiresAt,
      });
    },
    consume: async (tokenHash, nonceHash, now) => {
      consumeCalls.push({ tokenHash, nonceHash, now });
      return consumeResult;
    },
  };
  return { repository, issueCalls, consumeCalls };
}

function service(
  repository: MagicLinkRepository,
  now: () => Date,
  overrides: { rateLimitMax?: number; rateLimitWindowSeconds?: number } = {},
): MagicLinkService {
  return new MagicLinkService(repository, {
    ttlSeconds: 900,
    rateLimitMax: overrides.rateLimitMax ?? 3,
    rateLimitWindowSeconds: overrides.rateLimitWindowSeconds ?? 600,
    now,
  });
}

describe("MagicLinkService.request", () => {
  it("persists only the sha256 hash, never the raw token", async () => {
    const { repository, issueCalls } = fakeRepository();
    const issued = await service(repository, () => t0).request({
      siteId: "site-a",
      email: "user@example.com",
    });

    expect(issueCalls).toHaveLength(1);
    const stored = issueCalls[0]!;
    expect(stored.tokenHash).not.toBe(issued.linkToken);
    expect(stored.tokenHash).toBe(
      createHash("sha256").update(issued.linkToken).digest("hex"),
    );
    // 32 字节 CSPRNG → base64url 43 字符（无填充）。
    expect(issued.linkToken).toHaveLength(43);
  });

  it("generates a fresh token per request and sets expiresAt = now + ttl", async () => {
    const { repository, issueCalls } = fakeRepository();
    const svc = service(repository, () => t0);

    const first = await svc.request({ siteId: "site-a", email: "user@example.com" });
    const second = await svc.request({ siteId: "site-a", email: "user@example.com" });

    expect(first.linkToken).not.toBe(second.linkToken);
    expect(issueCalls[0]!.expiresAt).toEqual(new Date(t0.getTime() + 900_000));
    expect(issueCalls[0]!.now).toEqual(t0);
  });

  it("rate limits the same email inside the window and recovers after it", async () => {
    const { repository } = fakeRepository();
    let nowMs = t0.getTime();
    const svc = service(repository, () => new Date(nowMs), {
      rateLimitMax: 2,
      rateLimitWindowSeconds: 600,
    });
    const input = { siteId: "site-a", email: "burst@example.com" };

    await svc.request(input);
    await svc.request(input);
    await expect(svc.request(input)).rejects.toBeInstanceOf(MagicLinkRateLimitedError);
    // 其它邮箱不受影响。
    await svc.request({ siteId: "site-a", email: "other@example.com" });

    // 窗口滚过后同邮箱恢复。
    nowMs += 600_000;
    await expect(svc.request(input)).resolves.toBeDefined();
  });
});

describe("MagicLinkService.consume", () => {
  it("hashes the presented token and returns the transferred record", async () => {
    const stored = record({ tokenHash: hashMagicLinkToken("raw-token") });
    const { repository, consumeCalls } = fakeRepository(stored);

    const consumed = await service(repository, () => t0).consume("raw-token");

    // 未传 nonce → 以 null 匹配未绑定链。
    expect(consumeCalls).toEqual([
      { tokenHash: hashMagicLinkToken("raw-token"), nonceHash: null, now: t0 },
    ]);
    expect(consumed).toBe(stored);
  });

  it("forwards the nonce hash verbatim so the repository can enforce device binding", async () => {
    const stored = record({ tokenHash: hashMagicLinkToken("raw-token"), nonceHash: "nonce-hash" });
    const { repository, consumeCalls } = fakeRepository(stored);

    await service(repository, () => t0).consume("raw-token", "nonce-hash");

    expect(consumeCalls).toEqual([
      { tokenHash: hashMagicLinkToken("raw-token"), nonceHash: "nonce-hash", now: t0 },
    ]);
  });

  it("throws a single opaque error when the conditional transfer misses", async () => {
    const { repository } = fakeRepository(null);
    await expect(service(repository, () => t0).consume("whatever")).rejects.toBeInstanceOf(
      MagicLinkInvalidError,
    );
  });
});

describe("MagicLinkService.request nonce binding", () => {
  it("stores the nonce hash on issue when provided, null otherwise", async () => {
    const { repository, issueCalls } = fakeRepository();
    const svc = service(repository, () => t0);

    await svc.request({ siteId: "site-a", email: "bound@example.com", nonceHash: "nh" });
    await svc.request({ siteId: "site-a", email: "free@example.com" });

    expect(issueCalls[0]!.nonceHash).toBe("nh");
    expect(issueCalls[1]!.nonceHash).toBeNull();
  });
});

describe("magicLinkExternalUserId", () => {
  it("prefixes the email with its provider axis", () => {
    expect(magicLinkExternalUserId("user@example.com")).toBe("email|user@example.com");
  });
});
