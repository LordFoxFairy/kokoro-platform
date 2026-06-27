export function parsePositiveBigIntString(value: string, field: string): bigint {
  const amount = BigInt(value);

  if (amount <= 0n) {
    throw new Error(`${field} must be positive`);
  }

  return amount;
}
