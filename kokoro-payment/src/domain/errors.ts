export class PaymentIdempotencyConflictError extends Error {
  constructor(scope: string, key: string) {
    super(`Payment idempotency conflict for ${scope}: ${key}`);
    this.name = "PaymentIdempotencyConflictError";
  }
}
