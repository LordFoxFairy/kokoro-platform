import { describe, expect, it } from "vitest";
import {
  createOrderRequestSchema,
  recordPaymentEventRequestSchema,
  upsertPlanRequestSchema,
} from "../../src/interfaces/http/schemas.js";

const validPlan = {
  key: "studio",
  name: "Studio",
  currency: "USD",
  amountMinor: "4900",
  billingInterval: "month" as const,
};

const validOrder = {
  teamId: "team_1",
  planId: "plan_1",
  amountMinor: "4900",
  currency: "USD",
  idempotencyKey: "order_1",
};

const validEvent = {
  provider: "stripe",
  eventId: "evt_1",
  eventType: "invoice.paid",
  payload: { subscription: "sub_1" },
};

describe("payment HTTP schemas reject unknown fields (.strict)", () => {
  it("upsertPlanRequestSchema rejects extra keys", () => {
    expect(() => upsertPlanRequestSchema.parse({ ...validPlan, bogus: 1 })).toThrow();
  });
  it("createOrderRequestSchema rejects extra keys", () => {
    expect(() => createOrderRequestSchema.parse({ ...validOrder, bogus: 1 })).toThrow();
  });
  it("recordPaymentEventRequestSchema rejects extra keys", () => {
    expect(() => recordPaymentEventRequestSchema.parse({ ...validEvent, bogus: 1 })).toThrow();
  });
});

describe("amountMinor boundaries (/^[1-9]\\d*$/)", () => {
  it.each(["0", "-1", "", "abc", "01", " 5", "1.5", "12.0", "5x", "4 9"])(
    "upsertPlan rejects invalid amountMinor %j",
    (amountMinor) => {
      expect(() => upsertPlanRequestSchema.parse({ ...validPlan, amountMinor })).toThrow();
    },
  );
  it.each(["1", "4900", "99999999999999999999999999"])(
    "createOrder accepts positive integer string %j",
    (amountMinor) => {
      expect(createOrderRequestSchema.parse({ ...validOrder, amountMinor }).amountMinor).toBe(
        amountMinor,
      );
    },
  );
});

describe("plan creditMicros boundaries (/^\\d+$/, optional)", () => {
  it("accepts omitted creditMicros", () => {
    expect(upsertPlanRequestSchema.parse(validPlan).creditMicros).toBeUndefined();
  });
  it.each(["0", "1000000", "99999999999999999999999999"])(
    "accepts non-negative integer string %j",
    (creditMicros) => {
      expect(upsertPlanRequestSchema.parse({ ...validPlan, creditMicros }).creditMicros).toBe(
        creditMicros,
      );
    },
  );
  it.each(["-1", "1.5", "abc", "01x", " 5", "5 ", ""])(
    "rejects invalid creditMicros %j",
    (creditMicros) => {
      expect(() => upsertPlanRequestSchema.parse({ ...validPlan, creditMicros })).toThrow();
    },
  );
});

describe("plan enum + required + length", () => {
  it.each(["weekly", "", "MONTH", "Once"])("rejects invalid billingInterval %j", (interval) => {
    expect(() => upsertPlanRequestSchema.parse({ ...validPlan, billingInterval: interval })).toThrow();
  });
  it.each(["once", "month", "year"])("accepts valid billingInterval %j", (interval) => {
    expect(
      upsertPlanRequestSchema.parse({ ...validPlan, billingInterval: interval }).billingInterval,
    ).toBe(interval);
  });
  it.each(["US", "USDX", ""])("rejects non-3-char currency %j", (currency) => {
    expect(() => upsertPlanRequestSchema.parse({ ...validPlan, currency })).toThrow();
  });
  it("rejects empty plan name", () => {
    expect(() => upsertPlanRequestSchema.parse({ ...validPlan, name: "" })).toThrow();
  });
  it("rejects missing plan key", () => {
    const { key: _key, ...rest } = validPlan;
    expect(() => upsertPlanRequestSchema.parse(rest)).toThrow();
  });
});

describe("order required fields", () => {
  it("rejects empty idempotencyKey", () => {
    expect(() => createOrderRequestSchema.parse({ ...validOrder, idempotencyKey: "" })).toThrow();
  });
  it("rejects missing teamId", () => {
    const { teamId: _teamId, ...rest } = validOrder;
    expect(() => createOrderRequestSchema.parse(rest)).toThrow();
  });
  it("rejects missing planId", () => {
    const { planId: _planId, ...rest } = validOrder;
    expect(() => createOrderRequestSchema.parse(rest)).toThrow();
  });
});

describe("payment event required fields", () => {
  it.each(["provider", "eventId", "eventType"] as const)("rejects empty %s", (field) => {
    expect(() => recordPaymentEventRequestSchema.parse({ ...validEvent, [field]: "" })).toThrow();
  });
  it("accepts omitted payload", () => {
    const { payload: _payload, ...rest } = validEvent;
    expect(recordPaymentEventRequestSchema.parse(rest).payload).toBeUndefined();
  });
  it("accepts arbitrary JSON payload", () => {
    const payload = { nested: { list: [1, 2], flag: true } };
    expect(recordPaymentEventRequestSchema.parse({ ...validEvent, payload }).payload).toEqual(
      payload,
    );
  });
});
