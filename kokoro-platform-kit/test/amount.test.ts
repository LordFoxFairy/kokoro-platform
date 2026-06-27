import { describe, expect, it } from "vitest";
import { parsePositiveBigIntString } from "../src/domain/amount.js";

describe("parsePositiveBigIntString", () => {
  it("parses positive integer strings", () => {
    expect(parsePositiveBigIntString("123", "amountMicros")).toBe(123n);
  });

  it("rejects non-positive values", () => {
    expect(() => parsePositiveBigIntString("0", "amountMicros")).toThrow("amountMicros must be positive");
    expect(() => parsePositiveBigIntString("-1", "amountMicros")).toThrow("amountMicros must be positive");
  });
});
