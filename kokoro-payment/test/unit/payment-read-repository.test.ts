import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { PaymentRepository } from "../../src/domain/repository.js";
import {
  createPaymentReadRepository,
  PAYMENT_READ_METHODS,
  type PaymentReadRepository,
} from "../../src/interfaces/http/read-repository.js";

describe("createPaymentReadRepository", () => {
  it("exposes and binds only the declared read capabilities", async () => {
    const listPlans = vi.fn().mockResolvedValue([]);
    const fullRepository = {
      listOrders: vi.fn().mockResolvedValue([]),
      listPaymentEvents: vi.fn().mockResolvedValue([]),
      listPlans,
      listProviders: vi.fn().mockResolvedValue([]),
      listRefunds: vi.fn().mockResolvedValue([]),
      listSubscriptions: vi.fn().mockResolvedValue([]),
      readAdminStats: vi.fn().mockResolvedValue({}),
      createOrder: vi.fn(),
      recordPaymentEvent: vi.fn(),
    } as unknown as PaymentRepository;

    const reader = createPaymentReadRepository(fullRepository);

    expect(Object.keys(reader).sort()).toEqual([...PAYMENT_READ_METHODS].sort());
    expect(Object.isFrozen(reader)).toBe(true);
    expect(reader).not.toHaveProperty("createOrder");
    expect(reader).not.toHaveProperty("recordPaymentEvent");
    await reader.listPlans("site-1");
    expect(listPlans).toHaveBeenCalledWith("site-1");

    type HasWriteCapability = "createOrder" extends keyof PaymentReadRepository ? true : false;
    expectTypeOf<HasWriteCapability>().toEqualTypeOf<false>();
  });
});
