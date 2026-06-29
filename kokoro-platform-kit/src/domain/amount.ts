export function parsePositiveBigIntString(value: string, field: string): bigint {
  // WHY: 只接受十进制数字串，拒绝 BigInt() 会静默强转的 0x 前缀 / 正负号 / 空白等非规范钱款入参。
  if (!/^\d+$/.test(value)) {
    throw new Error(`${field} must be a decimal integer string`);
  }

  const amount = BigInt(value);

  if (amount <= 0n) {
    throw new Error(`${field} must be positive`);
  }

  return amount;
}
