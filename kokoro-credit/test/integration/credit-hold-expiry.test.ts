import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { CreditService, type RunBillingConfig } from "../../src/application/credit-service.js";
import { CreditHoldNotActiveError } from "../../src/domain/errors.js";
import { PrismaCreditRepository } from "../../src/infrastructure/prisma/prisma-credit-repository.js";
import { createCreditServer } from "../../src/interfaces/http/server.js";
import { cleanCreditDatabase, createTestPrismaClient } from "./helpers.js";

const prisma = createTestPrismaClient();
const repository = new PrismaCreditRepository(prisma);
const service = new CreditService(repository);
const app = createCreditServer({ prisma });

const SITE = "site-default";
const PAST = () => new Date(Date.now() - 60_000);
const FUTURE = () => new Date(Date.now() + 60 * 60_000);

async function fundedAccount(ownerId: string, grantMicros: string) {
  const account = await service.ensureAccount({ siteId: SITE, ownerKind: "team", ownerId });
  await service.grantCredits({
    accountId: account.id,
    amountMicros: grantMicros,
    idempotencyKey: `${ownerId}_grant`,
    reason: "subscription",
  });
  return account;
}

// 直接以指定 expiresAt 落一笔 active hold（holdCredits 会一并增账户 heldMicros，账面自洽）。
async function heldAccount(
  ownerId: string,
  grantMicros: string,
  holdMicros: string,
  expiresAt: Date | undefined,
) {
  const account = await fundedAccount(ownerId, grantMicros);
  const hold = await service.holdCredits({
    accountId: account.id,
    amountMicros: holdMicros,
    idempotencyKey: `${ownerId}_hold`,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    featureKey: "model.run",
  });
  return { account, hold };
}

describe("credit hold expiry reclamation", () => {
  beforeEach(async () => {
    await cleanCreditDatabase(prisma);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it("reclaims an expired active hold: frees held credit, marks it expired, leaves balance intact", async () => {
    const { account, hold } = await heldAccount("expire_reclaim", "1000", "400", PAST());

    const reclaimed = await service.sweepExpiredHolds();

    expect(reclaimed).toBe(1);
    const storedHold = await prisma.creditHold.findUniqueOrThrow({ where: { id: hold.id } });
    const stored = await prisma.creditAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(storedHold.status).toBe("expired");
    expect(stored.heldMicros.toString()).toBe("0");
    // 回收只退冻结、不动余额：过期不是消费。
    expect(stored.balanceMicros.toString()).toBe("1000");
  });

  it("leaves a not-yet-expired hold untouched", async () => {
    const { account, hold } = await heldAccount("expire_future", "1000", "400", FUTURE());

    const reclaimed = await service.sweepExpiredHolds();

    expect(reclaimed).toBe(0);
    const storedHold = await prisma.creditHold.findUniqueOrThrow({ where: { id: hold.id } });
    const stored = await prisma.creditAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(storedHold.status).toBe("active");
    expect(stored.heldMicros.toString()).toBe("400");
  });

  it("leaves a hold with no expiry (no TTL) untouched", async () => {
    const { account, hold } = await heldAccount("expire_noTtl", "1000", "400", undefined);

    const reclaimed = await service.sweepExpiredHolds();

    expect(reclaimed).toBe(0);
    const storedHold = await prisma.creditHold.findUniqueOrThrow({ where: { id: hold.id } });
    const stored = await prisma.creditAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(storedHold.status).toBe("active");
    expect(stored.heldMicros.toString()).toBe("400");
  });

  it("does not touch an already-captured hold even if its expiry has passed", async () => {
    const { account, hold } = await heldAccount("expire_captured", "1000", "400", PAST());
    await service.captureHold({
      holdId: hold.id,
      actualAmountMicros: "300",
      idempotencyKey: "expire_captured_entry",
      reason: "model_call",
      featureKey: "model.run",
    });

    const reclaimed = await service.sweepExpiredHolds();

    expect(reclaimed).toBe(0);
    const storedHold = await prisma.creditHold.findUniqueOrThrow({ where: { id: hold.id } });
    const stored = await prisma.creditAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(storedHold.status).toBe("captured");
    expect(stored.heldMicros.toString()).toBe("0");
    expect(stored.balanceMicros.toString()).toBe("700");
  });

  it("does not touch an already-released hold even if its expiry has passed", async () => {
    const { account, hold } = await heldAccount("expire_released", "1000", "400", PAST());
    await service.releaseHold({ holdId: hold.id, idempotencyKey: "expire_released_key" });

    const reclaimed = await service.sweepExpiredHolds();

    expect(reclaimed).toBe(0);
    const storedHold = await prisma.creditHold.findUniqueOrThrow({ where: { id: hold.id } });
    const stored = await prisma.creditAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(storedHold.status).toBe("released");
    expect(stored.heldMicros.toString()).toBe("0");
  });

  it("is idempotent: a second sweep reclaims nothing and never double-releases", async () => {
    const { account } = await heldAccount("expire_idem", "1000", "400", PAST());

    const first = await service.sweepExpiredHolds();
    const second = await service.sweepExpiredHolds();

    expect(first).toBe(1);
    expect(second).toBe(0);
    const stored = await prisma.creditAccount.findUniqueOrThrow({ where: { id: account.id } });
    // 若第二次误退，heldMicros 会被扣成负数。
    expect(stored.heldMicros.toString()).toBe("0");
  });

  it("rejects capturing a hold that was already reclaimed as expired", async () => {
    const { account, hold } = await heldAccount("expire_then_capture", "1000", "400", PAST());
    await service.sweepExpiredHolds();

    await expect(
      service.captureHold({
        holdId: hold.id,
        actualAmountMicros: "300",
        idempotencyKey: "expire_then_capture_entry",
        reason: "model_call",
        featureKey: "model.run",
      }),
    ).rejects.toBeInstanceOf(CreditHoldNotActiveError);

    // 晚到的结算不许复活已回收的钱：余额与冻结都不动。
    const stored = await prisma.creditAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(stored.balanceMicros.toString()).toBe("1000");
    expect(stored.heldMicros.toString()).toBe("0");
  });

  it("rejects releasing a hold that was already reclaimed as expired", async () => {
    const { account, hold } = await heldAccount("expire_then_release", "1000", "400", PAST());
    await service.sweepExpiredHolds();

    await expect(
      service.releaseHold({ holdId: hold.id, idempotencyKey: "expire_then_release_key" }),
    ).rejects.toBeInstanceOf(CreditHoldNotActiveError);

    const stored = await prisma.creditAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(stored.heldMicros.toString()).toBe("0");
  });

  it("under concurrent sweep vs capture on the same hold, exactly one wins (no double spend / double release)", async () => {
    const { account, hold } = await heldAccount("expire_race", "1000", "400", PAST());

    const [sweepResult, captureResult] = await Promise.allSettled([
      service.sweepExpiredHolds(),
      service.captureHold({
        holdId: hold.id,
        actualAmountMicros: "300",
        idempotencyKey: "expire_race_entry",
        reason: "model_call",
        featureKey: "model.run",
      }),
    ]);

    const captureWon = captureResult.status === "fulfilled";
    const sweepReclaimed = sweepResult.status === "fulfilled" && sweepResult.value === 1;
    // 二者互斥：要么 capture 抢到（sweep 回收 0），要么 sweep 抢到（capture 抛 not-active）。
    expect(captureWon).not.toBe(sweepReclaimed);

    const storedHold = await prisma.creditHold.findUniqueOrThrow({ where: { id: hold.id } });
    const stored = await prisma.creditAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(stored.heldMicros.toString()).toBe("0");
    const ledgerCount = await prisma.creditLedgerEntry.count({
      where: { accountId: account.id, reason: "model_call" },
    });

    if (captureWon) {
      expect(storedHold.status).toBe("captured");
      expect(stored.balanceMicros.toString()).toBe("700");
      expect(ledgerCount).toBe(1);
    } else {
      expect(captureResult.status === "rejected" && captureResult.reason).toBeInstanceOf(
        CreditHoldNotActiveError,
      );
      expect(storedHold.status).toBe("expired");
      expect(stored.balanceMicros.toString()).toBe("1000");
      expect(ledgerCount).toBe(0);
    }
  });

  it("reclaims only the expired holds in a mixed batch and reports the count", async () => {
    const a = await heldAccount("batch_expired_a", "1000", "100", PAST());
    const b = await heldAccount("batch_expired_b", "1000", "200", PAST());
    await heldAccount("batch_active", "1000", "300", FUTURE());

    const reclaimed = await service.sweepExpiredHolds();

    expect(reclaimed).toBe(2);
    const storedA = await prisma.creditAccount.findUniqueOrThrow({ where: { id: a.account.id } });
    const storedB = await prisma.creditAccount.findUniqueOrThrow({ where: { id: b.account.id } });
    expect(storedA.heldMicros.toString()).toBe("0");
    expect(storedB.heldMicros.toString()).toBe("0");
  });

  it("exposes POST /credit/holds/sweep returning the reclaimed count", async () => {
    await heldAccount("http_sweep", "1000", "400", PAST());

    const response = await app.inject({ method: "POST", url: "/credit/holds/sweep" });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ reclaimed: 1 });
  });
});

describe("usage hold TTL", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const ttlBilling: RunBillingConfig = {
    inputUnit: "input_token",
    outputUnit: "output_token",
    estInputTokens: "1000",
    estOutputTokens: "1000",
    bufferPercent: 20,
    holdTtlSeconds: 3600,
  };
  const ttlService = new CreditService(repository, undefined, ttlBilling);

  beforeEach(async () => {
    await cleanCreditDatabase(prisma);
    const from = new Date(Date.now() - DAY);
    await prisma.pricingRule.createMany({
      data: [
        { featureKey: "model.run", labelKey: null, unit: "input_token", amountMicros: 1n, status: "active", effectiveFrom: from },
        { featureKey: "model.run", labelKey: null, unit: "output_token", amountMicros: 3n, status: "active", effectiveFrom: from },
      ],
    });
  });

  it("stamps expiresAt = now + configured TTL on a usage hold", async () => {
    await service.ensureAccount({ siteId: SITE, ownerKind: "team", ownerId: "ttl_team" });
    const account = await service.ensureAccount({ siteId: SITE, ownerKind: "team", ownerId: "ttl_team" });
    await service.grantCredits({
      accountId: account.id,
      amountMicros: "100000",
      idempotencyKey: "ttl_grant",
      reason: "subscription",
    });

    const before = Date.now();
    const held = await ttlService.holdForUsage({
      siteId: SITE,
      namespace: "ttl_team",
      featureKey: "model.run",
      idempotencyKey: "ttl_hold",
    });
    const after = Date.now();

    const storedHold = await prisma.creditHold.findUniqueOrThrow({ where: { id: held.holdId } });
    expect(storedHold.expiresAt).not.toBeNull();
    const expiresMs = storedHold.expiresAt!.getTime();
    expect(expiresMs).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(expiresMs).toBeLessThanOrEqual(after + 3600 * 1000);
  });
});
