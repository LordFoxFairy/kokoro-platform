export class PaymentIdempotencyConflictError extends Error {
  constructor(scope: string, key: string) {
    super(`Payment idempotency conflict for ${scope}: ${key}`);
    this.name = "PaymentIdempotencyConflictError";
  }
}

export class OrderNotFoundError extends Error {
  constructor(orderId: string) {
    super(`Order not found: ${orderId}`);
    this.name = "OrderNotFoundError";
  }
}

export class OrderNotConfirmableError extends Error {
  constructor(orderId: string, status: string) {
    super(`Order ${orderId} is not confirmable from status ${status}`);
    this.name = "OrderNotConfirmableError";
  }
}

export class PlanNotFoundError extends Error {
  constructor(planId: string) {
    super(`Plan not found: ${planId}`);
    this.name = "PlanNotFoundError";
  }
}

export class OrderNotRefundableError extends Error {
  constructor(orderId: string, status: string) {
    super(`Order ${orderId} is not refundable from status ${status}`);
    this.name = "OrderNotRefundableError";
  }
}

export class OrderAmountMismatchError extends Error {
  constructor(planId: string) {
    super(`Order amount does not match plan pricing: ${planId}`);
    this.name = "OrderAmountMismatchError";
  }
}

export class PaymentProviderNotFoundError extends Error {
  constructor(key: string) {
    super(`Payment provider not found: ${key}`);
    this.name = "PaymentProviderNotFoundError";
  }
}

export class PaymentEventNotFoundError extends Error {
  constructor(id: string) {
    super(`Payment event not found: ${id}`);
    this.name = "PaymentEventNotFoundError";
  }
}
