import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import { PrismaRefreshTokenRepository } from "../../src/infrastructure/prisma/prisma-refresh-token-repository.js";

const now = new Date("2026-07-15T00:00:00.000Z");

// 覆盖 repo 用到的 refreshToken 子集 + $transaction 的进程内 fake（无需真实 DB）。
// 语义足以校验条件转移(行锁在真库保证)、重放吊销、轮换链登记。
interface Row {
  id: string;
  namespace: string;
  siteId: string;
  tokenHash: string;
  tokenPrefix: string;
  expiresAt: Date;
  consumedAt: Date | null;
  revokedAt: Date | null;
  replacedById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface Where {
  id?: string;
  tokenHash?: string;
  namespace?: string;
  consumedAt?: null;
  revokedAt?: null;
  expiresAt?: { gt: Date };
}

function matches(row: Row, where: Where): boolean {
  if (where.id !== undefined && row.id !== where.id) return false;
  if (where.tokenHash !== undefined && row.tokenHash !== where.tokenHash) return false;
  if (where.namespace !== undefined && row.namespace !== where.namespace) return false;
  if (where.consumedAt === null && row.consumedAt !== null) return false;
  if (where.revokedAt === null && row.revokedAt !== null) return false;
  if (where.expiresAt !== undefined && !(row.expiresAt.getTime() > where.expiresAt.gt.getTime())) return false;
  return true;
}

function createFakePrisma(): { prisma: PrismaClient; rows: Row[] } {
  const rows: Row[] = [];
  let seq = 0;
  const model = {
    create: async ({ data }: { data: Omit<Row, "id" | "consumedAt" | "revokedAt" | "replacedById" | "createdAt" | "updatedAt"> }) => {
      const row: Row = {
        id: `rt-${(seq += 1)}`,
        consumedAt: null,
        revokedAt: null,
        replacedById: null,
        createdAt: now,
        updatedAt: now,
        ...data,
      };
      rows.push(row);
      return row;
    },
    findUnique: async ({ where }: { where: Where }) => rows.find((r) => matches(r, where)) ?? null,
    update: async ({ where, data }: { where: Where; data: Partial<Row> }) => {
      const row = rows.find((r) => matches(r, where));
      if (!row) throw new Error("not found");
      Object.assign(row, data);
      return row;
    },
    updateMany: async ({ where, data }: { where: Where; data: Partial<Row> }) => {
      const targets = rows.filter((r) => matches(r, where));
      for (const r of targets) Object.assign(r, data);
      return { count: targets.length };
    },
  };
  const prisma = {
    refreshToken: model,
    $transaction: async (fn: (tx: unknown) => unknown) => fn({ refreshToken: model }),
  } as unknown as PrismaClient;
  return { prisma, rows };
}

describe("PrismaRefreshTokenRepository", () => {
  let prisma: PrismaClient;
  let rows: Row[];
  let repo: PrismaRefreshTokenRepository;

  beforeEach(() => {
    const fake = createFakePrisma();
    prisma = fake.prisma;
    rows = fake.rows;
    repo = new PrismaRefreshTokenRepository(prisma);
  });

  it("issue persists the record", async () => {
    const rec = await repo.issue({
      namespace: "ns1",
      siteId: "site-a",
      tokenHash: "h1",
      tokenPrefix: "prefix-abcd12",
      expiresAt: new Date(now.getTime() + 1000),
    });
    expect(rec.namespace).toBe("ns1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe("h1");
    expect(rows[0]!.consumedAt).toBeNull();
  });

  it("consume transfers exactly once and stamps consumedAt (happy path)", async () => {
    rows.push(row({ tokenHash: "live", expiresAt: new Date(now.getTime() + 10_000) }));
    const consumed = await repo.consume("live", now);
    expect(consumed).not.toBeNull();
    expect(consumed!.consumedAt).toEqual(now);
    // 二次消费同一 token → null（已 consumed，条件转移不再命中）。
    const second = await repo.consume("live", new Date(now.getTime() + 1));
    expect(second).toBeNull();
  });

  it("returns null for an expired token without revoking the namespace (not a replay)", async () => {
    rows.push(row({ namespace: "nsE", tokenHash: "exp", expiresAt: new Date(now.getTime() - 1) }));
    rows.push(row({ id: "sibling", namespace: "nsE", tokenHash: "sibling", expiresAt: new Date(now.getTime() + 10_000) }));
    const result = await repo.consume("exp", now);
    expect(result).toBeNull();
    // 过期未消费不算重放：兄弟活链不应被吊销。
    expect(rows.find((r) => r.id === "sibling")!.revokedAt).toBeNull();
  });

  it("revokes the whole namespace when a token consumed beyond the grace window is replayed", async () => {
    // 已消费很久（超出 60s grace）的 refresh 又被出示 = 疑似泄露重放，吊销整链兜底。
    rows.push(row({ namespace: "nsR", tokenHash: "used", consumedAt: new Date(now.getTime() - 120_000) }));
    rows.push(row({ id: "live-a", namespace: "nsR", tokenHash: "live-a", expiresAt: new Date(now.getTime() + 10_000) }));
    rows.push(row({ id: "other-ns", namespace: "nsOther", tokenHash: "other", expiresAt: new Date(now.getTime() + 10_000) }));

    const result = await repo.consume("used", now);
    expect(result).toBeNull();
    // 重放兜底：该 namespace 全部活 refresh 被吊销。
    expect(rows.find((r) => r.id === "live-a")!.revokedAt).toEqual(now);
    // 其它 namespace 不受牵连。
    expect(rows.find((r) => r.id === "other-ns")!.revokedAt).toBeNull();
  });

  it("does NOT revoke on concurrent reuse within the grace window (multi-tab)", async () => {
    // 刚被合法轮换（grace 内 3s）的 refresh 被并发再次出示 = 正常多 tab，不吊销（否则误踢），仅返 null。
    rows.push(row({ namespace: "nsC", tokenHash: "used-recent", consumedAt: new Date(now.getTime() - 3000) }));
    rows.push(row({ id: "live-c", namespace: "nsC", tokenHash: "live-c", expiresAt: new Date(now.getTime() + 10_000) }));

    const result = await repo.consume("used-recent", now);
    expect(result).toBeNull();
    // grace 内并发不吊销：兄弟活链保持有效，用户不被踢下线。
    expect(rows.find((r) => r.id === "live-c")!.revokedAt).toBeNull();
  });

  it("returns null for a garbage hash and revokes nothing", async () => {
    rows.push(row({ namespace: "nsG", tokenHash: "real", expiresAt: new Date(now.getTime() + 10_000) }));
    const result = await repo.consume("does-not-exist", now);
    expect(result).toBeNull();
    expect(rows.find((r) => r.tokenHash === "real")!.revokedAt).toBeNull();
  });

  it("markReplaced links the old record to the new one", async () => {
    rows.push(row({ id: "old", tokenHash: "old" }));
    await repo.markReplaced("old", "new");
    expect(rows.find((r) => r.id === "old")!.replacedById).toBe("new");
  });

  it("revokeAllForNamespace revokes only active tokens of that namespace", async () => {
    rows.push(row({ id: "a", namespace: "nsX", tokenHash: "a" }));
    rows.push(row({ id: "b", namespace: "nsX", tokenHash: "b", revokedAt: new Date(now.getTime() - 1) }));
    rows.push(row({ id: "c", namespace: "nsY", tokenHash: "c" }));
    await repo.revokeAllForNamespace("nsX", now);
    expect(rows.find((r) => r.id === "a")!.revokedAt).toEqual(now);
    // 已吊销的不被覆盖时间。
    expect(rows.find((r) => r.id === "b")!.revokedAt).not.toEqual(now);
    // 别的 namespace 不动。
    expect(rows.find((r) => r.id === "c")!.revokedAt).toBeNull();
  });

  it("findByHash returns the row or null", async () => {
    rows.push(row({ tokenHash: "findme" }));
    expect((await repo.findByHash("findme"))!.tokenHash).toBe("findme");
    expect(await repo.findByHash("nope")).toBeNull();
  });
});

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: `r-${Math.random().toString(36).slice(2)}`,
    namespace: "ns1",
    siteId: "site-a",
    tokenHash: "hash",
    tokenPrefix: "prefix-abcd12",
    expiresAt: new Date(now.getTime() + 2_592_000_000),
    consumedAt: null,
    revokedAt: null,
    replacedById: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
