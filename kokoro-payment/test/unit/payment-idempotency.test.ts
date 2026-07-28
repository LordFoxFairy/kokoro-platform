import { describe, expect, it } from "vitest";
import { PaymentIdempotencyConflictError } from "../../src/domain/errors.js";
import {
  assertSameOrderIdempotencyTarget,
  assertSamePaymentEventIdempotencyTarget,
  type OrderIdempotencyTarget,
  type PaymentEventIdempotencyTarget,
} from "../../src/domain/idempotency.js";

const order: OrderIdempotencyTarget = {
  siteId: "site_1",
  teamId: "team_1",
  planId: "plan_1",
  amountMinor: "4900",
  currency: "USD",
  idempotencyKey: "k1",
};

describe("assertSameOrderIdempotencyTarget", () => {
  it("passes for identical targets", () => {
    expect(() => assertSameOrderIdempotencyTarget(order, { ...order })).not.toThrow();
  });

  it.each(["siteId", "teamId", "planId", "amountMinor", "currency"] as const)(
    "throws conflict when %s differs",
    (field) => {
      expect(() =>
        assertSameOrderIdempotencyTarget(order, { ...order, [field]: "different" }),
      ).toThrow(PaymentIdempotencyConflictError);
    },
  );

  it("ignores idempotencyKey when comparing identity", () => {
    expect(() =>
      assertSameOrderIdempotencyTarget(order, { ...order, idempotencyKey: "k2" }),
    ).not.toThrow();
  });
});

const event: PaymentEventIdempotencyTarget = {
  provider: "stripe",
  eventId: "evt_1",
  eventType: "invoice.paid",
  payload: { a: 1, b: [2, 3] },
};

describe("assertSamePaymentEventIdempotencyTarget", () => {
  it("passes for identical targets", () => {
    expect(() => assertSamePaymentEventIdempotencyTarget(event, { ...event })).not.toThrow();
  });

  it("passes when payload keys differ only in order (canonical)", () => {
    expect(() =>
      assertSamePaymentEventIdempotencyTarget(event, { ...event, payload: { b: [2, 3], a: 1 } }),
    ).not.toThrow();
  });

  it("throws conflict when eventType differs", () => {
    expect(() =>
      assertSamePaymentEventIdempotencyTarget(event, { ...event, eventType: "invoice.failed" }),
    ).toThrow(PaymentIdempotencyConflictError);
  });

  it("throws conflict when payload differs", () => {
    expect(() =>
      assertSamePaymentEventIdempotencyTarget(event, { ...event, payload: { a: 2, b: [2, 3] } }),
    ).toThrow(PaymentIdempotencyConflictError);
  });

  it.each([
    [undefined, undefined],
    [undefined, {}],
    [{}, undefined],
  ])("treats nullish payload %j and %j as equal to empty object", (left, right) => {
    expect(() =>
      assertSamePaymentEventIdempotencyTarget(
        { ...event, payload: left },
        { ...event, payload: right },
      ),
    ).not.toThrow();
  });
});
