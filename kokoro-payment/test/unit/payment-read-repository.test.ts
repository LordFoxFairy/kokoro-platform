import type { PrismaClient } from "../../generated/prisma/index.js";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  PAYMENT_ADMIN_READ_METHODS,
  PAYMENT_CATALOG_READ_METHODS,
  type PaymentAdminRepository,
  type PaymentCatalogRepository,
} from "../../src/domain/read-repository.js";
import * as readAdapter from "../../src/infrastructure/prisma/prisma-payment-read-repository.js";
import { PrismaPaymentReadRepository } from "../../src/infrastructure/prisma/prisma-payment-read-repository.js";

describe("PrismaPaymentReadRepository", () => {
  it("implements exactly the declared read capability surface", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repository = new PrismaPaymentReadRepository({
      plan: { findMany },
    } as unknown as PrismaClient);

    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(repository)).sort()).toEqual([
      "constructor",
      ...PAYMENT_ADMIN_READ_METHODS,
    ].sort());
    expect(Reflect.ownKeys(repository)).toEqual([]);
    expect("createOrder" in repository).toBe(false);
    expect("recordPaymentEvent" in repository).toBe(false);
    expect("prisma" in repository).toBe(false);

    await repository.listPlans("site-1");
    expect(findMany).toHaveBeenCalledWith({
      where: { deletedAt: null, siteId: "site-1" },
      take: 100,
      orderBy: { createdAt: "desc" },
    });

    type HasWriteCapability = "createOrder" extends keyof PaymentAdminRepository ? true : false;
    expectTypeOf<HasWriteCapability>().toEqualTypeOf<false>();
    expectTypeOf<keyof PaymentCatalogRepository>().toEqualTypeOf<
      (typeof PAYMENT_CATALOG_READ_METHODS)[number]
    >();
    expectTypeOf<keyof PaymentAdminRepository>().toEqualTypeOf<
      (typeof PAYMENT_ADMIN_READ_METHODS)[number]
    >();
  });

  it("returns frozen catalogue and admin capabilities without the backing client", () => {
    expect(readAdapter).toHaveProperty("createPrismaPaymentReadCapabilities");
    const capabilities = readAdapter.createPrismaPaymentReadCapabilities({
      plan: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaClient);

    expect(Object.isFrozen(capabilities)).toBe(true);
    expect(Reflect.ownKeys(capabilities).sort()).toEqual(["admin", "catalog"]);
    expect(Object.isFrozen(capabilities.catalog)).toBe(true);
    expect(Reflect.ownKeys(capabilities.catalog)).toEqual(["listPlans"]);
    expect(Object.isFrozen(capabilities.admin)).toBe(true);
    expect(Reflect.ownKeys(capabilities.admin).sort()).toEqual(
      PAYMENT_ADMIN_READ_METHODS.slice().sort(),
    );
    expect("prisma" in capabilities).toBe(false);
    expect("close" in capabilities).toBe(false);
  });

  it("keeps lifecycle control outside the capability object passed to HTTP", async () => {
    const store = readAdapter.openPrismaPaymentReadStore(
      "mysql://payment_reader:pw@127.0.0.1:3306/payment",
    );
    expect(Reflect.ownKeys(store).sort()).toEqual(["capabilities", "close"]);
    expect(Reflect.ownKeys(store.capabilities).sort()).toEqual(["admin", "catalog"]);
    await store.close();
  });
});
