import { describe, expect, it } from "vitest";
import { parsePositiveBigIntString } from "../src/domain/amount.js";

describe("parsePositiveBigIntString", () => {
  it.each([
    ["123", 123n],
    ["1", 1n],
    ["000123", 123n],
    ["99999999999999999999999999", 99999999999999999999999999n],
  ])("parses positive %s -> %s", (input, expected) => {
    expect(parsePositiveBigIntString(input, "amountMicros")).toBe(expected);
  });

  it("rejects zero with the positive message", () => {
    expect(() => parsePositiveBigIntString("0", "amountMicros")).toThrow(
      "amountMicros must be positive",
    );
  });

  it.each([
    "",
    " ",
    "abc",
    "1.5",
    "12n",
    "1_000",
    "0x10",
    "+5",
    " 5 ",
    "5 ",
    "-1",
    "-99999999999999999999",
  ])(
    "throws on non-decimal input %s",
    (input) => {
      expect(() => parsePositiveBigIntString(input, "amountMicros")).toThrow();
    },
  );

  it("uses the field name in the error message", () => {
    expect(() => parsePositiveBigIntString("0", "creditMicros")).toThrow(
      "creditMicros must be positive",
    );
  });
});
