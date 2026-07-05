import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { CreditService } from "../../src/application/credit-service.js";
import { InsufficientCreditError } from "../../src/domain/errors.js";
import { PrismaCreditRepository } from "../../src/infrastructure/prisma/prisma-credit-repository.js";
import { cleanCreditDatabase, createTestPrismaClient } from "./helpers.js";

const prisma = createTestPrismaClient();
const repository = new PrismaCreditRepository(prisma);
const service = new CreditService(repository);

describe("PrismaCreditRepository", () => {
  beforeEach(async () => {
    await cleanCreditDatabase(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("ensures an account and grants credits idempotently", async () => {
    const account = await service.ensureAccount({
      siteId: "site-default",
      ownerKind: "team",
      ownerId: "team_1",
    });

    const first = await service.grantCredits({
      accountId: account.id,
      amountMicros: "5000000",
      idempotencyKey: "grant_1",
      reason: "manual_adjustment",
    });

    const second = await service.grantCredits({
      accountId: account.id,
      amountMicros: "5000000",
      idempotencyKey: "grant_1",
      reason: "manual_adjustment",
    });

    expect(second.entry.id).toBe(first.entry.id);
    expect(second.account.balanceMicros).toBe("5000000");
  });

  it("handles concurrent grant requests with the same idempotency key", async () => {
    const account = await service.ensureAccount({
      siteId: "site-default",
      ownerKind: "team",
      ownerId: "team_concurrent_grant",
    });

    const [first, second] = await Promise.all([
      service.grantCredits({
        accountId: account.id,
        amountMicros: "7000000",
        idempotencyKey: "grant_concurrent",
        reason: "manual_adjustment",
      }),
      service.grantCredits({
        accountId: account.id,
        amountMicros: "7000000",
        idempotencyKey: "grant_concurrent",
        reason: "manual_adjustment",
      }),
    ]);

    const storedAccount = await prisma.creditAccount.findUniqueOrThrow({
      where: {
        id: account.id,
      },
    });

    expect(second.entry.id).toBe(first.entry.id);
    expect(storedAccount.balanceMicros.toString()).toBe("7000000");
  });

  it("spends credits and writes a negative ledger entry", async () => {
    const account = await service.ensureAccount({
      siteId: "site-default",
      ownerKind: "team",
      ownerId: "team_2",
    });

    await service.grantCredits({
      accountId: account.id,
      amountMicros: "9000000",
      idempotencyKey: "grant_2",
      reason: "subscription",
    });

    const spend = await service.spendCredits({
      accountId: account.id,
      amountMicros: "3000000",
      idempotencyKey: "spend_1",
      reason: "model_call",
    });

    expect(spend.account.balanceMicros).toBe("6000000");
    expect(spend.entry.amountMicros).toBe("-3000000");
  });

  it("handles concurrent spend requests with the same idempotency key", async () => {
    const account = await service.ensureAccount({
      siteId: "site-default",
      ownerKind: "team",
      ownerId: "team_concurrent_spend",
    });

    await service.grantCredits({
      accountId: account.id,
      amountMicros: "9000000",
      idempotencyKey: "grant_before_concurrent_spend",
      reason: "subscription",
    });

    const [first, second] = await Promise.all([
      service.spendCredits({
        accountId: account.id,
        amountMicros: "3000000",
        idempotencyKey: "spend_concurrent",
        reason: "model_call",
      }),
      service.spendCredits({
        accountId: account.id,
        amountMicros: "3000000",
        idempotencyKey: "spend_concurrent",
        reason: "model_call",
      }),
    ]);

    const storedAccount = await prisma.creditAccount.findUniqueOrThrow({
      where: {
        id: account.id,
      },
    });

    expect(second.entry.id).toBe(first.entry.id);
    expect(storedAccount.balanceMicros.toString()).toBe("6000000");
  });

  it("rejects spending more than the available balance", async () => {
    const account = await service.ensureAccount({
      siteId: "site-default",
      ownerKind: "team",
      ownerId: "team_3",
    });

    await expect(
      service.spendCredits({
        accountId: account.id,
        amountMicros: "1",
        idempotencyKey: "spend_overdraft",
        reason: "model_call",
      }),
    ).rejects.toBeInstanceOf(InsufficientCreditError);
  });

  it("isolates accounts by siteId for the same (ownerKind, ownerId)", async () => {
    const onA = await service.ensureAccount({ siteId: "site-a", ownerKind: "user", ownerId: "shared_owner" });
    const onB = await service.ensureAccount({ siteId: "site-b", ownerKind: "user", ownerId: "shared_owner" });

    expect(onA.id).not.toBe(onB.id);
    expect(onA.siteId).toBe("site-a");
    expect(onB.siteId).toBe("site-b");

    await service.grantCredits({
      accountId: onA.id,
      amountMicros: "4000000",
      idempotencyKey: "site_a_grant",
      reason: "manual_adjustment",
    });

    const reloadedA = await repository.getAccountById(onA.id);
    const reloadedB = await repository.getAccountById(onB.id);
    expect(reloadedA?.balanceMicros).toBe("4000000");
    expect(reloadedB?.balanceMicros).toBe("0");

    const sameOwnerAgain = await service.ensureAccount({ siteId: "site-a", ownerKind: "user", ownerId: "shared_owner" });
    expect(sameOwnerAgain.id).toBe(onA.id);
  });

  it("keeps hold accounting precise under concurrency within a single site", async () => {
    const account = await service.ensureAccount({ siteId: "site-conc", ownerKind: "team", ownerId: "team_hold_race" });
    await service.grantCredits({
      accountId: account.id,
      amountMicros: "5000000",
      idempotencyKey: "hold_race_grant",
      reason: "subscription",
    });

    // 6 个并发各冻结 1_000_000，可用额只够 5 个：原子条件更新必须恰好放行 5 个、拒 1 个。
    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) =>
        service.holdCredits({
          accountId: account.id,
          amountMicros: "1000000",
          idempotencyKey: `hold_race_${index}`,
        }),
      ),
    );

    const granted = attempts.filter((a) => a.status === "fulfilled").length;
    expect(granted).toBe(5);

    const stored = await prisma.creditAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(stored.heldMicros.toString()).toBe("5000000");
    expect(stored.balanceMicros.toString()).toBe("5000000");
  });

  it("deletes and restores an account without deleting ledger or usage facts", async () => {
    const account = await service.ensureAccount({
      siteId: "site-default",
      ownerKind: "team",
      ownerId: "team_delete_restore",
    });
    await service.grantCredits({
      accountId: account.id,
      amountMicros: "9000000",
      idempotencyKey: "delete_restore_grant",
      reason: "subscription",
    });
    const hold = await service.holdCredits({
      accountId: account.id,
      amountMicros: "3000000",
      idempotencyKey: "delete_restore_hold",
    });
    await service.captureHold({
      holdId: hold.id,
      actualAmountMicros: "2000000",
      idempotencyKey: "delete_restore_capture",
      reason: "model_call",
      featureKey: "model.call",
      requestId: "req_delete_restore",
    });

    const deleted = await repository.deleteAccount({
      id: account.id,
      deletedBy: "operator-1",
      reason: "owner closed",
    });

    expect(deleted.deletedAt).toBeInstanceOf(Date);
    expect(deleted.deletedBy).toBe("operator-1");
    expect(deleted.deleteReason).toBe("owner closed");
    expect(await repository.listAccounts("site-default")).toEqual([]);
    expect(await repository.listAccounts("site-default", { includeDeleted: true })).toContainEqual(
      expect.objectContaining({ id: account.id, deletedBy: "operator-1" }),
    );
    expect(await repository.listLedgerByAccount(account.id)).toHaveLength(2);
    expect(await repository.listUsageByAccount(account.id)).toHaveLength(1);

    await expect(
      service.ensureAccount({
        siteId: "site-default",
        ownerKind: "team",
        ownerId: "team_delete_restore",
      }),
    ).rejects.toMatchObject({ code: "credit.account.deleted" });

    const restored = await repository.restoreAccount({ id: account.id });
    expect(restored.deletedAt).toBeNull();
    expect(restored.deletedBy).toBeNull();
    expect(restored.deleteReason).toBeNull();
    expect(await repository.listAccounts("site-default")).toContainEqual(
      expect.objectContaining({ id: account.id }),
    );
  });

  it("rejects deleting an account while it has active holds", async () => {
    const account = await service.ensureAccount({
      siteId: "site-default",
      ownerKind: "team",
      ownerId: "team_delete_active_hold",
    });
    await service.grantCredits({
      accountId: account.id,
      amountMicros: "5000000",
      idempotencyKey: "delete_active_hold_grant",
      reason: "subscription",
    });
    await service.holdCredits({
      accountId: account.id,
      amountMicros: "1000000",
      idempotencyKey: "delete_active_hold",
    });

    await expect(
      repository.deleteAccount({
        id: account.id,
        deletedBy: "operator-1",
        reason: "owner closed",
      }),
    ).rejects.toMatchObject({ code: "credit.account.active_hold_exists" });
  });
});
