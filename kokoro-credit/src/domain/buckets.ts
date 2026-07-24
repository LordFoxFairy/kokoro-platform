// 三桶余额：按"过期节奏"分——每日（每天重置）/ 周期（订阅月度重置）/ 永久（积分包，不过期）。
//
// 纯域逻辑：不碰 DB、不碰时钟。now/水位判定（是否到新周期）由调用方算好、以 stale 标志注入；
// 域只做确定性算术（可无副作用单测）。落库的原子性由 repo 层负责，这里只算"该怎么动"。
//
// 消费顺序 = 过期最快先扣（每日→周期→永久）：先花会过期的，永久的兜底，用户价值永不被静默作废。

export type BucketKind = "daily" | "period" | "permanent";

// 消费顺序：过期最快先扣。
export const consumptionOrder: readonly BucketKind[] = ["daily", "period", "permanent"];

export interface Buckets {
  readonly daily: bigint;
  readonly period: bigint;
  readonly permanent: bigint;
}

// 时间型桶的额度来源（来自账户生效 Plan：免费/订阅的每日、订阅的月度）。
export interface Allowances {
  readonly daily: bigint;
  readonly period: bigint;
}

// debit 结果：每桶实际扣减量 + 未满足的差额（shortfall>0 表示余额不足，不透支）。
export interface Debit {
  readonly daily: bigint;
  readonly period: bigint;
  readonly permanent: bigint;
  readonly shortfall: bigint;
}

// 可用总额 = 三桶之和。
export function available(b: Buckets): bigint {
  return b.daily + b.period + b.permanent;
}

// 按消费顺序（每日→周期→永久）扣 amount。返回每桶扣减量 + shortfall（不足则扣光并记差额，绝不透支）。
export function debit(b: Buckets, amount: bigint): Debit {
  let remaining = amount > 0n ? amount : 0n;
  const take = (bucket: bigint): bigint => {
    const t = bucket < remaining ? bucket : remaining;
    remaining -= t;
    return t;
  };
  const daily = take(b.daily);
  const period = take(b.period);
  const permanent = take(b.permanent);
  return { daily, period, permanent, shortfall: remaining };
}

// 惰性刷新：到期的时间型桶重置为额度（overwrite——旧余额作废，use-or-lose，非累加）；永久桶永不动。
// dailyStale/periodStale 由调用方按水位<当前周期边界算出（域不碰时钟）。
export function refresh(
  b: Buckets,
  allowances: Allowances,
  stale: { dailyStale: boolean; periodStale: boolean },
): Buckets {
  return {
    daily: stale.dailyStale ? allowances.daily : b.daily,
    period: stale.periodStale ? allowances.period : b.period,
    permanent: b.permanent,
  };
}

// 归还：settle 释放 hold 未用差额时，按扣减来源逆向补回各桶。
export function creditBack(
  b: Buckets,
  delta: { daily: bigint; period: bigint; permanent: bigint },
): Buckets {
  return {
    daily: b.daily + delta.daily,
    period: b.period + delta.period,
    permanent: b.permanent + delta.permanent,
  };
}
