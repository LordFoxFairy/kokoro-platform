// WHY: creditMicros 允许 0（不授予），与共享库只允许正数的 parsePositiveBigIntString 区分。
export function parseNonNegativeBigIntString(value: string, field: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return BigInt(value);
}
