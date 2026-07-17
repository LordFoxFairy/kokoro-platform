// 积分记账单位换算与解析。
// WHY: reset 目标余额允许 0（清零/纠偏），与共享库只允许正数的 parsePositiveBigIntString 区分。
export function parseNonNegativeBigIntString(value: string, field: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return BigInt(value);
}

// 用户面单位：1 积分 = 10_000 micros（内部 micros 精确记账，积分为整数售卖/展示单位）。
// 与 PRD 2026-07-17-credit-pricing-strategy §2 一致；结算向上取整以此为边界。
export const MICROS_PER_CREDIT = 10_000n;

// micros 向上取整到整积分边界（house-favor：碎屑归房）。
export function ceilToCreditMicros(micros: bigint): bigint {
  if (micros <= 0n) {
    return 0n;
  }
  const rem = micros % MICROS_PER_CREDIT;
  return rem === 0n ? micros : micros + (MICROS_PER_CREDIT - rem);
}
