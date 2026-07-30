export type HoldAllocationAvailability = Readonly<{
  creditGrantId: string;
  ordinal: number;
  allocatedAmount: bigint;
  netCustomerAmount: bigint;
}>;

export type HoldSourceCapture = Readonly<{
  creditGrantId: string;
  amount: bigint;
  ordinal: number;
}>;

export type HoldSourceCorrection = HoldSourceCapture & Readonly<{
  direction: "increase" | "decrease";
}>;

export function planHoldCapture(
  allocations: readonly HoldAllocationAvailability[],
  amount: bigint,
): readonly HoldSourceCapture[] {
  if (amount < 0n) throw new Error("CREDIT_SETTLEMENT_AMOUNT_INVALID");
  return plan(allocations, amount, (allocation) => allocation.allocatedAmount - allocation.netCustomerAmount)
    .map(({ allocation, amount: sourceAmount }) => Object.freeze({
      creditGrantId: allocation.creditGrantId,
      amount: sourceAmount,
      ordinal: allocation.ordinal,
    }));
}

export function planSettlementCorrection(
  allocations: readonly HoldAllocationAvailability[],
  delta: bigint,
): readonly HoldSourceCorrection[] {
  if (delta === 0n) return Object.freeze([]);
  const direction = delta > 0n ? "increase" as const : "decrease" as const;
  const planned = plan(
    allocations,
    delta > 0n ? delta : -delta,
    direction === "increase"
      ? (allocation) => allocation.allocatedAmount - allocation.netCustomerAmount
      : (allocation) => allocation.netCustomerAmount,
    direction === "decrease",
  );
  return Object.freeze(planned.map(({ allocation, amount }) => Object.freeze({
    creditGrantId: allocation.creditGrantId,
    amount,
    ordinal: allocation.ordinal,
    direction,
  })));
}

function plan(
  allocations: readonly HoldAllocationAvailability[],
  amount: bigint,
  capacity: (allocation: HoldAllocationAvailability) => bigint,
  reverse = false,
): readonly Readonly<{ allocation: HoldAllocationAvailability; amount: bigint }>[] {
  const ordered = [...allocations].map(validate)
    .sort((left, right) => reverse ? right.ordinal - left.ordinal : left.ordinal - right.ordinal);
  if (new Set(ordered.map((allocation) => allocation.creditGrantId)).size !== ordered.length ||
      new Set(ordered.map((allocation) => allocation.ordinal)).size !== ordered.length) {
    throw new Error("CREDIT_SETTLEMENT_HOLD_ALLOCATION_DUPLICATE");
  }
  let remaining = amount;
  const result: Readonly<{ allocation: HoldAllocationAvailability; amount: bigint }>[] = [];
  for (const allocation of ordered) {
    if (remaining === 0n) break;
    const available = capacity(allocation);
    if (available <= 0n) continue;
    const consumed = available < remaining ? available : remaining;
    result.push(Object.freeze({ allocation, amount: consumed }));
    remaining -= consumed;
  }
  if (remaining !== 0n) throw new Error("CREDIT_SETTLEMENT_HOLD_CAPACITY_EXCEEDED");
  return Object.freeze(result);
}

function validate(allocation: HoldAllocationAvailability): HoldAllocationAvailability {
  if (allocation.creditGrantId.length < 1 || allocation.creditGrantId.length > 256 ||
      !Number.isSafeInteger(allocation.ordinal) || allocation.ordinal < 0 ||
      allocation.allocatedAmount <= 0n || allocation.netCustomerAmount < 0n ||
      allocation.netCustomerAmount > allocation.allocatedAmount) {
    throw new Error("CREDIT_SETTLEMENT_HOLD_ALLOCATION_INVALID");
  }
  return allocation;
}
