import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RefreshService } from "../../src/application/refresh-service.js";
import {
  hashRefreshToken,
  RefreshTokenInvalidError,
  type IssueRefreshTokenInput,
  type RefreshTokenRecord,
  type RefreshTokenRepository,
} from "../../src/domain/refresh-token.js";
import type { SessionTokenClaims } from "../../src/domain/session.js";

const t0 = new Date("2026-07-15T00:00:00.000Z");

function record(overrides: Partial<RefreshTokenRecord> = {}): RefreshTokenRecord {
  return {
    id: "rt1",
    namespace: "clteam0001",
    siteId: "site-a",
    tokenHash: "hash",
    tokenPrefix: "prefix",
    expiresAt: new Date(t0.getTime() + 2_592_000_000),
    consumedAt: null,
    revokedAt: null,
    replacedById: null,
    createdAt: t0,
    ...overrides,
  };
}

function fakeRepository(consumeResult: RefreshTokenRecord | null = null): {
  repository: RefreshTokenRepository;
  issueCalls: IssueRefreshTokenInput[];
  consumeCalls: { tokenHash: string; now: Date }[];
  markReplacedCalls: { oldId: string; newId: string }[];
  issuedIds: string[];
} {
  const issueCalls: IssueRefreshTokenInput[] = [];
  const consumeCalls: { tokenHash: string; now: Date }[] = [];
  const markReplacedCalls: { oldId: string; newId: string }[] = [];
  const issuedIds: string[] = [];
  let seq = 0;
  const repository: RefreshTokenRepository = {
    issue: async (input) => {
      issueCalls.push(input);
      const id = `issued-${(seq += 1)}`;
      issuedIds.push(id);
      return record({ id, ...input });
    },
    consume: async (tokenHash, now) => {
      consumeCalls.push({ tokenHash, now });
      return consumeResult;
    },
    markReplaced: async (oldId, newId) => {
      markReplacedCalls.push({ oldId, newId });
    },
    revokeAllForNamespace: async () => {},
    findByHash: async () => null,
  };
  return { repository, issueCalls, consumeCalls, markReplacedCalls, issuedIds };
}

function captureSigner(): { sign: (c: SessionTokenClaims) => Promise<string>; claims: SessionTokenClaims[] } {
  const claims: SessionTokenClaims[] = [];
  return {
    claims,
    sign: async (c) => {
      claims.push(c);
      return `signed:${c.sub}`;
    },
  };
}

function service(
  repository: RefreshTokenRepository,
  signer: { sign: (c: SessionTokenClaims) => Promise<string> },
  now: () => Date,
): RefreshService {
  return new RefreshService(repository, signer, {
    issuer: "kokoro-user",
    jwtTtlSeconds: 3600,
    refreshTtlSeconds: 2_592_000,
    now,
  });
}

describe("RefreshService.issue", () => {
  it("persists only the sha256 hash + 12-char prefix, never the raw token", async () => {
    const { repository, issueCalls } = fakeRepository();
    const issued = await service(repository, captureSigner(), () => t0).issue("clteam0001", "site-a");

    expect(issueCalls).toHaveLength(1);
    const stored = issueCalls[0]!;
    expect(stored.namespace).toBe("clteam0001");
    expect(stored.siteId).toBe("site-a");
    expect(stored.tokenHash).not.toBe(issued.refreshToken);
    expect(stored.tokenHash).toBe(createHash("sha256").update(issued.refreshToken).digest("hex"));
    // 前缀=明文前 12 字符（非密），且确实是原文子串。
    expect(stored.tokenPrefix).toBe(issued.refreshToken.slice(0, 12));
    expect(stored.tokenPrefix).toHaveLength(12);
    // 32 字节 CSPRNG → base64url 43 字符（无填充）。
    expect(issued.refreshToken).toHaveLength(43);
    // expiresAt = now + refreshTtl。
    expect(issued.expiresAt).toEqual(new Date(t0.getTime() + 2_592_000_000));
  });

  it("generates a fresh token per issue", async () => {
    const { repository } = fakeRepository();
    const svc = service(repository, captureSigner(), () => t0);
    const a = await svc.issue("clteam0001", "site-a");
    const b = await svc.issue("clteam0001", "site-a");
    expect(a.refreshToken).not.toBe(b.refreshToken);
  });
});

describe("RefreshService.rotate", () => {
  it("consumes the old token, signs a new access JWT, issues a rotated refresh, and links the chain", async () => {
    const old = record({ id: "old-1", tokenHash: hashRefreshToken("old-plain") });
    const { repository, consumeCalls, issueCalls, markReplacedCalls } = fakeRepository(old);
    const signer = captureSigner();

    const rotated = await service(repository, signer, () => t0).rotate("old-plain");

    // 消费旧 token：以其哈希调 repo.consume。
    expect(consumeCalls).toEqual([{ tokenHash: hashRefreshToken("old-plain"), now: t0 }]);

    // 新 access JWT：sub=namespace，iat/exp 按注入时钟。
    const iat = Math.floor(t0.getTime() / 1000);
    expect(signer.claims).toEqual([
      { sub: "clteam0001", iss: "kokoro-user", siteId: "site-a", issuedAtSeconds: iat, expiresAtSeconds: iat + 3600 },
    ]);
    expect(rotated.token).toBe("signed:clteam0001");
    expect(rotated.namespace).toBe("clteam0001");
    expect(rotated.siteId).toBe("site-a");

    // 轮换：签发一条新 refresh（原文≠旧原文，只落哈希）。
    expect(issueCalls).toHaveLength(1);
    expect(rotated.refreshToken).not.toBe("old-plain");
    expect(issueCalls[0]!.tokenHash).toBe(hashRefreshToken(rotated.refreshToken));
    expect(rotated.refreshExpiresAt).toEqual(new Date(t0.getTime() + 2_592_000_000));

    // 轮换链登记：旧 id → 新 id。
    expect(markReplacedCalls).toEqual([{ oldId: "old-1", newId: "issued-1" }]);
  });

  it("throws a single opaque error when consume misses (invalid/expired/revoked/replayed)", async () => {
    // repo.consume 返回 null 统摄 无效/过期/吊销/重放（重放兜底吊销在 repo 层做，服务层只见 null）。
    const { repository, issueCalls, markReplacedCalls } = fakeRepository(null);
    const signer = captureSigner();

    await expect(service(repository, signer, () => t0).rotate("whatever")).rejects.toBeInstanceOf(
      RefreshTokenInvalidError,
    );
    // 消费失败绝不签新 token、不发新 refresh、不动轮换链。
    expect(signer.claims).toHaveLength(0);
    expect(issueCalls).toHaveLength(0);
    expect(markReplacedCalls).toHaveLength(0);
  });
});
