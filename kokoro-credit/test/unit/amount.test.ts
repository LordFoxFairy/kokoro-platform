import { describe, expect, it } from "vitest";
import { ceilToCreditMicros, MICROS_PER_CREDIT, parseNonNegativeBigIntString } from "../../src/domain/amount.js";

describe("MICROS_PER_CREDIT", () => {
  it("是 10_000（1 积分 = 10000 micros，与 PRD 一致）", () => {
    expect(MICROS_PER_CREDIT).toBe(10_000n);
  });
});

describe("parseNonNegativeBigIntString", () => {
  it("接受 0 与正整数串", () => {
    expect(parseNonNegativeBigIntString("0", "x")).toBe(0n);
    expect(parseNonNegativeBigIntString("12345", "x")).toBe(12345n);
  });
  it("拒绝负数/小数/空/非数字", () => {
    for (const bad of ["-1", "1.5", "", "abc", "1e3", " 1"]) {
      expect(() => parseNonNegativeBigIntString(bad, "x")).toThrow();
    }
  });
});

describe("ceilToCreditMicros（house-favor 向上取整到整积分）", () => {
  it("0 与负数 → 0（零用量不收费）", () => {
    expect(ceilToCreditMicros(0n)).toBe(0n);
    expect(ceilToCreditMicros(-5n)).toBe(0n);
  });
  it("任意非零 → 至少 1 积分（天然保底，无零收入）", () => {
    expect(ceilToCreditMicros(1n)).toBe(10_000n);
    expect(ceilToCreditMicros(2200n)).toBe(10_000n);
    expect(ceilToCreditMicros(9999n)).toBe(10_000n);
  });
  it("整积分不膨胀；跨边界向上取整", () => {
    expect(ceilToCreditMicros(10_000n)).toBe(10_000n);
    expect(ceilToCreditMicros(10_001n)).toBe(20_000n);
    expect(ceilToCreditMicros(30_000n)).toBe(30_000n);
    expect(ceilToCreditMicros(80_000n)).toBe(80_000n);
  });
});
