import { describe, expect, it } from "vitest";
import { dailyBoundary, isStale, periodBoundary } from "../../src/domain/reset-boundary.js";

// 懒刷新水位边界:统一按 UTC 自然日/自然月判断(标准做法——存储/边界算 UTC,展示层才转本地时区;
// 与既有 quotaPeriod="monthly" 同口径)。纯函数,不读真时钟,now 由调用方传入,可确定性单测。
describe("dailyBoundary（UTC 自然日零点）", () => {
  it("同一天内任意时刻 → 当天 UTC 零点", () => {
    expect(dailyBoundary(new Date("2026-07-24T23:59:59.999Z")).toISOString()).toBe("2026-07-24T00:00:00.000Z");
    expect(dailyBoundary(new Date("2026-07-24T00:00:00.000Z")).toISOString()).toBe("2026-07-24T00:00:00.000Z");
  });

  it("跨月/跨年边界正确进位", () => {
    expect(dailyBoundary(new Date("2027-01-01T05:00:00.000Z")).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("periodBoundary（UTC 自然月 1 日零点）", () => {
  it("月中任意时刻 → 当月 1 日 UTC 零点", () => {
    expect(periodBoundary(new Date("2026-07-24T23:59:59.999Z")).toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("跨年边界正确进位", () => {
    expect(periodBoundary(new Date("2027-01-15T00:00:00.000Z")).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("isStale（存量水位 < 当前边界 即过期；null 视为过期）", () => {
  const boundary = new Date("2026-07-24T00:00:00.000Z");

  it("null 水位（未初始化）→ 过期", () => {
    expect(isStale(null, boundary)).toBe(true);
  });

  it("水位早于当前边界 → 过期", () => {
    expect(isStale(new Date("2026-07-23T00:00:00.000Z"), boundary)).toBe(true);
  });

  it("水位等于当前边界 → 未过期（同一周期内，惰性不重复刷新）", () => {
    expect(isStale(boundary, boundary)).toBe(false);
  });

  it("水位晚于当前边界（异常但防御）→ 未过期", () => {
    expect(isStale(new Date("2026-07-25T00:00:00.000Z"), boundary)).toBe(false);
  });
});
