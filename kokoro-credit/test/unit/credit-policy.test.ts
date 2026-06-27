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
});
