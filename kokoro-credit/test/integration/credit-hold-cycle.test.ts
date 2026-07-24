import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { CreditService } from "../../src/application/credit-service.js";
import {
  CreditCaptureExceedsHoldError,
  CreditHoldNotActiveError,
  InsufficientCreditError,
} from "../../src/domain/errors.js";
import { PrismaCreditRepository } from "../../src/infrastructure/prisma/prisma-credit-repository.js";
import { cleanCreditDatabase, createTestPrismaClient } from "./helpers.js";

const prisma = createTestPrismaClient();
const repository = new PrismaCreditRepository(prisma);
const service = new CreditService(repository);

async function fundedAccount(ownerId: string, grantMicros: string) {
  const account = await service.ensureAccount({ siteId: "site-default", ownerKind: "team", ownerId });
  await service.grantCredits({
    accountId: account.id,
    amountMicros: grantMicros,
    idempotencyKey: `${ownerId}_grant`,
    reason: "subscription",
  });
  return account;
}

describe("credit reserve-commit-refund cycle", () => {
  beforeEach(async () => {
    await cleanCreditDatabase(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("never over-reserves under concurrent holds (row lock serializes)", async () => {
    const account = await fundedAccount("hold_concurrent", "100");

    const attempts = await Promise.allSettled(
      Array.from({ length: 10 }, (_unused, index) =>
        service.holdCredits({
          accountId: account.id,
          amountMicros: "30",
          idempotencyKey: `hold_concurrent_${index}`,
        }),
      ),
    );

    const succeeded = attempts.filter((result) => result.status === "fulfilled").length;
    const rejectedInsufficient = attempts.filter(
      (result) => result.status === "rejected" && result.reason instanceof InsufficientCreditError,
    ).length;
    const stored = await prisma.creditAccount.findUniqueOrThrow({ where: { id: account.id } });

    expect(succeeded).toBe(3);
    expect(rejectedInsufficient).toBe(7);
    expect(stored.heldMicros).toBe(90n);
    // B1：预留在 hold 时按序移出桶——3×30=90 全从永久桶移出，永久桶精确剩 10、绝不透支（无超额预留）。
    expect(stored.balanceMicros).toBe(10n);
    expect(stored.dailyMicros + stored.periodMicros + stored.balanceMicros).toBe(10n); // 可用总额=10
  });

  it("spend cannot consume held (reserved) funds", async () => {
    const account = await fundedAccount("spend_vs_held", "100");
    await service.holdCredits({
      accountId: account.id,
      amountMicros: "60",
      idempotencyKey: "svh_hold",
    });

    // available = 100 - 60 = 40; spend 50 必须失败，不得动用冻结资金
    await expect(
      service.spendCredits({
        accountId: account.id,
        amountMicros: "50",
        idempotencyKey: "svh_spend_fail",
        reason: "model_call",
      }),
    ).rejects.toThrow(InsufficientCreditError);

    // spend 40（== available）成功
    const result = await service.spendCredits({
      accountId: account.id,
      amountMicros: "40",
      idempotencyKey: "svh_spend_ok",
      reason: "model_call",
    });
    // B1：hold 已把 60 移出永久桶（100→40），spend 40 再扣光永久桶→0；balanceMicros=永久桶=0。
    expect(result.account.balanceMicros).toBe("0");

    const stored = await prisma.creditAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(stored.balanceMicros).toBe(0n);
    // 冻结的 60 分文未动（spend 只能消费桶内可用额，预留已移出桶）——这就是「不得动用已冻结」。
    expect(stored.heldMicros).toBe(60n);
    expect(stored.dailyMicros + stored.periodMicros + stored.balanceMicros).toBe(0n); // 可用总额已扣光
  });

  it("holding lowers available and moves funds out of the bucket (B1 decrement-at-hold)", async () => {
    const account = await fundedAccount("hold_lowers_available", "9000000");

    const hold = await service.holdCredits({
      accountId: account.id,
      amountMicros: "4000000",
      idempotencyKey: "hold_a",
    });

    const stored = await prisma.creditAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(hold.status).toBe("active");
    expect(hold.amountMicros).toBe("4000000");
    // B1：预留在 hold 时就从永久桶移出（9M→5M），held 记 4M；available=桶之和=5M。
    expect(stored.balanceMicros.toString()).toBe("5000000");
    expect(stored.heldMicros.toString()).toBe("4000000");
    expect((stored.dailyMicros + stored.periodMicros + stored.balanceMicros).toString()).toBe("5000000");
  });

  it("rejects a hold that exceeds available credit", async () => {
    const account = await fundedAccount("hold_overdraft", "1000000");

    await service.holdCredits({
      accountId: account.id,
      amountMicros: "800000",
      idempotencyKey: "hold_overdraft_first",
    });

    await expect(
      service.holdCredits({
        accountId: account.id,
        amountMicros: "300000",
        idempotencyKey: "hold_overdraft_second",
      }),
    ).rejects.toBeInstanceOf(InsufficientCreditError);
  });

  it("returns the same hold for a repeated idempotency key", async () => {
    const account = await fundedAccount("hold_idempotent", "9000000");

    const first = await service.holdCredits({
      accountId: account.id,
      amountMicros: "4000000",
      idempotencyKey: "hold_idem",
    });
    const second = await service.holdCredits({
      accountId: account.id,
      amountMicros: "4000000",
      idempotencyKey: "hold_idem",
    });

    const stored = await prisma.creditAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(second.id).toBe(first.id);
    expect(stored.heldMicros.toString()).toBe("4000000");
  });

  it("captures actual amount, clears the hold, and writes ledger + usage", async () => {
    const account = await fundedAccount("capture_full", "9000000");

    const hold = await service.holdCredits({
      accountId: account.id,
      amountMicros: "4000000",
      idempotencyKey: "capture_hold",
    });

    const captured = await service.captureHold({
      holdId: hold.id,
      actualAmountMicros: "3000000",
      idempotencyKey: "capture_entry",
      reason: "model_call",
      featureKey: "model.call",
      modelBindingId: "binding_1",
      requestId: "req_1",
    });

    const stored = await prisma.creditAccount.findUniqueOrThrow({ where: { id: account.id } });
    const storedHold = await prisma.creditHold.findUniqueOrThrow({ where: { id: hold.id } });
    const usage = await prisma.usageRecord.findUniqueOrThrow({
      where: { idempotencyKey: "capture_entry:usage" },
    });

    expect(captured.entry.amountMicros).toBe("-3000000");
    expect(captured.entry.balanceAfterMicros).toBe("6000000");
    expect(captured.entry.requestId).toBe("req_1");
    // balance -= actual, held -= full hold (1000000 diff returns to available)
    expect(stored.balanceMicros.toString()).toBe("6000000");
    expect(stored.heldMicros.toString()).toBe("0");
    expect(storedHold.status).toBe("captured");
    expect(usage.status).toBe("settled");
    expect(usage.amountMicros.toString()).toBe("3000000");
    expect(usage.featureKey).toBe("model.call");
    expect(usage.modelBindingId).toBe("binding_1");
  });

  it("captures idempotently without double charging", async () => {
    const account = await fundedAccount("capture_idempotent", "9000000");
    const hold = await service.holdCredits({
      accountId: account.id,
      amountMicros: "4000000",
      idempotencyKey: "capture_idem_hold",
    });

    const first = await service.captureHold({
      holdId: hold.id,
      actualAmountMicros: "3000000",
      idempotencyKey: "capture_idem_entry",
      reason: "model_call",
      featureKey: "model.call",
    });
    const second = await service.captureHold({
      holdId: hold.id,
      actualAmountMicros: "3000000",
      idempotencyKey: "capture_idem_entry",
      reason: "model_call",
      featureKey: "model.call",
    });

    const stored = await prisma.creditAccount.findUniqueOrThrow({ where: { id: account.id } });
    const usageCount = await prisma.usageRecord.count({ where: { accountId: account.id } });
    expect(second.entry.id).toBe(first.entry.id);
    expect(stored.balanceMicros.toString()).toBe("6000000");
    expect(stored.heldMicros.toString()).toBe("0");
    expect(usageCount).toBe(1);
  });

  it("rejects capturing more than the hold amount", async () => {
    const account = await fundedAccount("capture_exceeds", "9000000");
    const hold = await service.holdCredits({
      accountId: account.id,
      amountMicros: "2000000",
      idempotencyKey: "capture_exceeds_hold",
    });

    await expect(
      service.captureHold({
        holdId: hold.id,
        actualAmountMicros: "2000001",
        idempotencyKey: "capture_exceeds_entry",
        reason: "model_call",
        featureKey: "model.call",
      }),
    ).rejects.toBeInstanceOf(CreditCaptureExceedsHoldError);

    const stored = await prisma.creditAccount.findUniqueOrThrow({ where: { id: account.id } });
    // B1：hold 已把 2M 从永久桶移出（9M→7M）；capture 被拒不改状态，桶维持 7M、held 维持 2M。
    expect(stored.balanceMicros.toString()).toBe("7000000");
    expect(stored.heldMicros.toString()).toBe("2000000");
  });

  it("releases an active hold and frees held credit", async () => {
    const account = await fundedAccount("release_active", "9000000");
    const hold = await service.holdCredits({
      accountId: account.id,
      amountMicros: "4000000",
      idempotencyKey: "release_hold",
    });

    const released = await service.releaseHold({ holdId: hold.id, idempotencyKey: "release_key" });
    const stored = await prisma.creditAccount.findUniqueOrThrow({ where: { id: account.id } });

    expect(released.status).toBe("released");
    expect(stored.balanceMicros.toString()).toBe("9000000");
    expect(stored.heldMicros.toString()).toBe("0");
  });

  it("releases idempotently for an already-released hold", async () => {
    const account = await fundedAccount("release_idempotent", "9000000");
    const hold = await service.holdCredits({
      accountId: account.id,
      amountMicros: "4000000",
      idempotencyKey: "release_idem_hold",
    });

    await service.releaseHold({ holdId: hold.id, idempotencyKey: "release_idem_key" });
    const second = await service.releaseHold({ holdId: hold.id, idempotencyKey: "release_idem_key" });
    const stored = await prisma.creditAccount.findUniqueOrThrow({ where: { id: account.id } });

    expect(second.status).toBe("released");
    expect(stored.heldMicros.toString()).toBe("0");
  });

  it("rejects releasing a captured hold", async () => {
    const account = await fundedAccount("release_captured", "9000000");
    const hold = await service.holdCredits({
      accountId: account.id,
      amountMicros: "4000000",
      idempotencyKey: "release_captured_hold",
    });
    await service.captureHold({
      holdId: hold.id,
      actualAmountMicros: "3000000",
      idempotencyKey: "release_captured_entry",
      reason: "model_call",
      featureKey: "model.call",
    });

    await expect(
      service.releaseHold({ holdId: hold.id, idempotencyKey: "release_captured_key" }),
    ).rejects.toBeInstanceOf(CreditHoldNotActiveError);
  });
});
