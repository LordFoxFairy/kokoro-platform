import type { PrismaClient } from "../../generated/prisma/index.js";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  PAYMENT_READ_METHODS,
  type PaymentAdminRepository,
} from "../../src/domain/read-repository.js";
import { PrismaPaymentReadRepository } from "../../src/infrastructure/prisma/prisma-payment-read-repository.js";

describe("PrismaPaymentReadRepository", () => {
  it("implements exactly the declared read capability surface", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repository = new PrismaPaymentReadRepository({
      plan: { findMany },
    } as unknown as PrismaClient);

    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(repository)).sort()).toEqual([
      "constructor",
      ...PAYMENT_READ_METHODS,
    ].sort());
    expect("createOrder" in repository).toBe(false);
    expect("recordPaymentEvent" in repository).toBe(false);

    await repository.listPlans("site-1");
    expect(findMany).toHaveBeenCalledWith({
      where: { deletedAt: null, siteId: "site-1" },
      take: 100,
      orderBy: { createdAt: "desc" },
    });

    type HasWriteCapability = "createOrder" extends keyof PaymentAdminRepository ? true : false;
    expectTypeOf<HasWriteCapability>().toEqualTypeOf<false>();
  });
});
