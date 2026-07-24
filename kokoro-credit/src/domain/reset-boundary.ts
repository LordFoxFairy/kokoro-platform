// 懒刷新水位边界:统一按 UTC 自然日/自然月判断（标准做法——存储/边界计算走 UTC，展示层才转本地时区；
// 与既有 quotaPeriod="monthly" 同口径）。纯函数，不读真时钟：now 由调用方显式传入，域外无副作用。
//
// *ResetOn 语义：存"当前桶值对应的边界日期"（该边界的 UTC 零点）。now 算出的边界晚于存量水位即过期，
// 需按 refresh() 重置为额度、并把水位推进到新边界。

export function dailyBoundary(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function periodBoundary(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function isStale(resetOn: Date | null, boundary: Date): boolean {
  return resetOn === null || resetOn.getTime() < boundary.getTime();
}
