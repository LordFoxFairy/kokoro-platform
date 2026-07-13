import { describe, expect, it } from "vitest";
import {
  CreditAccountNotFoundError,
  InsufficientCreditError,
  QuotaExceededError,
} from "../../src/domain/errors.js";

describe("credit domain errors", () => {
  it("CreditAccountNotFoundError carries account id and name", () => {
    const err = new CreditAccountNotFoundError("acc_1");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("CreditAccountNotFoundError");
    expect(err.message).toContain("acc_1");
  });

  it("InsufficientCreditError carries account id and name", () => {
    const err = new InsufficientCreditError("acc_2");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("InsufficientCreditError");
    expect(err.message).toContain("acc_2");
  });

  it("QuotaExceededError carries account id and a distinct name", () => {
    const err = new QuotaExceededError("acc_3");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("QuotaExceededError");
    expect(err.message).toContain("acc_3");
  });
});
