import { describe, expect, it } from "vitest";

import {
  available,
  consumptionOrder,
  creditBack,
  debit,
  refresh,
  type Buckets,
} from "../../src/domain/buckets.js";

// 三桶：按过期节奏分（每日/周期/永久）。纯域逻辑，无 DB/时钟依赖——
// now/水位判定由调用方注入，域只做算术，可确定性单测。
const B = (daily: bigint, period: bigint, permanent: bigint): Buckets => ({ daily, period, permanent });

describe("consumptionOrder", () => {
  it("过期最快先扣：每日 → 周期 → 永久", () => {
    expect(consumptionOrder).toEqual(["daily", "period", "permanent"]);
  });
});

describe("available", () => {
  it("= 三桶之和", () => {
    expect(available(B(30n, 200n, 5000n))).toBe(5230n);
  });
  it("空桶为 0", () => {
    expect(available(B(0n, 0n, 0n))).toBe(0n);
  });
});

describe("debit（按消费顺序扣，返回每桶扣减 + shortfall）", () => {
  it("全落在每日桶（够扣）：只扣 daily", () => {
    expect(debit(B(100n, 200n, 300n), 40n)).toEqual({ daily: 40n, period: 0n, permanent: 0n, shortfall: 0n });
  });

  it("跨桶按序：每日不够则溢到周期，再溢到永久", () => {
    // 扣 250：daily 100 全扣 → period 150 → permanent 0
    expect(debit(B(100n, 200n, 300n), 250n)).toEqual({ daily: 100n, period: 150n, permanent: 0n, shortfall: 0n });
  });

  it("扣到永久桶：三桶依次耗尽", () => {
    // 扣 350：daily 100 + period 200 + permanent 50
    expect(debit(B(100n, 200n, 300n), 350n)).toEqual({ daily: 100n, period: 200n, permanent: 50n, shortfall: 0n });
  });

  it("余额不足：尽力扣光三桶，shortfall 记差额（不透支）", () => {
    // 扣 700 但只有 600：三桶扣光，shortfall=100
    expect(debit(B(100n, 200n, 300n), 700n)).toEqual({ daily: 100n, period: 200n, permanent: 300n, shortfall: 100n });
  });

  it("扣 0：三桶不动", () => {
    expect(debit(B(100n, 200n, 300n), 0n)).toEqual({ daily: 0n, period: 0n, permanent: 0n, shortfall: 0n });
  });

  it("精确扣光：无 shortfall、无残留", () => {
    expect(debit(B(100n, 200n, 300n), 600n)).toEqual({ daily: 100n, period: 200n, permanent: 300n, shortfall: 0n });
  });
});

describe("refresh（惰性刷新：到新周期则重置，reset 非累加）", () => {
  it("每日到期：daily 重置为额度（overwrite，旧余额作废）", () => {
    // daily 有残留 30，dailyStale → 重置为额度 50（不是 30+50）
    expect(refresh(B(30n, 200n, 5000n), { daily: 50n, period: 500n }, { dailyStale: true, periodStale: false })).toEqual(
      B(50n, 200n, 5000n),
    );
  });

  it("周期到期：period 重置为额度；permanent 永不动", () => {
    expect(refresh(B(30n, 10n, 5000n), { daily: 50n, period: 500n }, { dailyStale: false, periodStale: true })).toEqual(
      B(30n, 500n, 5000n),
    );
  });

  it("都到期：daily 与 period 双重置，permanent 不动", () => {
    expect(refresh(B(30n, 10n, 5000n), { daily: 50n, period: 500n }, { dailyStale: true, periodStale: true })).toEqual(
      B(50n, 500n, 5000n),
    );
  });

  it("都未到期：三桶原样（惰性不动）", () => {
    expect(refresh(B(30n, 10n, 5000n), { daily: 50n, period: 500n }, { dailyStale: false, periodStale: false })).toEqual(
      B(30n, 10n, 5000n),
    );
  });
});

describe("creditBack（settle 释放差额：按来源归还各桶）", () => {
  it("把 hold 未用的差额按桶归还", () => {
    // 当前桶 + 归还 {daily:10, period:20, permanent:5}
    expect(creditBack(B(40n, 180n, 300n), { daily: 10n, period: 20n, permanent: 5n })).toEqual(B(50n, 200n, 305n));
  });

  it("零归还不动", () => {
    expect(creditBack(B(40n, 180n, 300n), { daily: 0n, period: 0n, permanent: 0n })).toEqual(B(40n, 180n, 300n));
  });
});
