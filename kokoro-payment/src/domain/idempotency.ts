import { PaymentIdempotencyConflictError } from "./errors.js";

export interface OrderIdempotencyTarget {
  teamId: string;
  planId: string;
  amountMinor: string;
  currency: string;
  idempotencyKey: string;
}

export interface PaymentEventIdempotencyTarget {
  provider: string;
  eventId: string;
  eventType: string;
  payload?: unknown;
}

export function assertSameOrderIdempotencyTarget(
  existing: OrderIdempotencyTarget,
  requested: OrderIdempotencyTarget,
): void {
  if (
    existing.teamId !== requested.teamId ||
    existing.planId !== requested.planId ||
    existing.amountMinor !== requested.amountMinor ||
    existing.currency !== requested.currency
  ) {
    throw new PaymentIdempotencyConflictError("order", requested.idempotencyKey);
  }
}

export function assertSamePaymentEventIdempotencyTarget(
  existing: PaymentEventIdempotencyTarget,
  requested: PaymentEventIdempotencyTarget,
): void {
  if (
    existing.eventType !== requested.eventType ||
    stableJson(existing.payload) !== stableJson(requested.payload)
  ) {
    throw new PaymentIdempotencyConflictError(
      "payment_event",
      `${requested.provider}:${requested.eventId}`,
    );
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value ?? {}));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }

  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        result[key] = canonicalize((value as Record<string, unknown>)[key]);
        return result;
      }, {});
  }

  return value;
}
