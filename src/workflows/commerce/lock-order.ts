export const COMMERCE_LOCK_ORDER = [
  "program_availability",
  "batch_availability",
  "code",
  "billing_account",
  "subscription",
  "term_allocation",
  "credit_account",
  "credit_grant",
  "credit_hold",
  "hold_allocation",
] as const;

export type CommerceLockNode = typeof COMMERCE_LOCK_ORDER[number];

export class CommerceLockSequence {
  #last = -1;

  enter(node: CommerceLockNode): void {
    const next = COMMERCE_LOCK_ORDER.indexOf(node);
    if (next < this.#last) throw new Error("COMMERCE_LOCK_ORDER_VIOLATION");
    if (next === this.#last) throw new Error("COMMERCE_LOCK_NODE_REENTERED");
    this.#last = next;
  }
}
