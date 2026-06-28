import { describe, expect, it } from "vitest";
import { assertCreditSpendAllowed } from "../../src/domain/credit-policy.js";
import { InsufficientCreditError } from "../../src/domain/errors.js";

describe("credit spend policy", () => {
  it("allows spending the full available balance", () => {
    expect(() => assertCreditSpendAllowed("account_1", 100n, 100n)).not.toThrow();
  });

  it("throws a domain error when available balance is insufficient", () => {
    expect(() => assertCreditSpendAllowed("account_1", 99n, 100n)).toThrow(InsufficientCreditError);
  });

  it.each<[bigint, bigint]>([
    [0n, 0n],
    [1n, 1n],
    [1n, 0n],
    [10n ** 30n, 10n ** 30n],
  ])("allows balance %s >= amount %s", (balance, amount) => {
    expect(() => assertCreditSpendAllowed("account_1", balance, amount)).not.toThrow();
  });

  it.each<[bigint, bigint]>([
    [0n, 1n],
    [10n ** 30n, 10n ** 30n + 1n],
  ])("throws when balance %s < amount %s", (balance, amount) => {
    expect(() => assertCreditSpendAllowed("account_1", balance, amount)).toThrow(
      InsufficientCreditError,
    );
  });
});
