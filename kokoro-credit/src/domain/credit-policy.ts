import { InsufficientCreditError } from "./errors.js";

export function assertCreditSpendAllowed(accountId: string, balanceMicros: bigint, amountMicros: bigint): void {
  if (balanceMicros < amountMicros) {
    throw new InsufficientCreditError(accountId);
  }
}
