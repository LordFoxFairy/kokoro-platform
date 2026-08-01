import { describe, expect, it } from "vitest";
import {
  createFulfillmentSourceIdentity,
  createFrozenFulfillmentSnapshot,
} from "../../src/modules/commerce/domain/fulfillment-source.js";

const digest = (value: string) => value.repeat(64);

describe("Fulfillment acquisition identity", () => {
  it("derives one stable idempotency key from Site and acquisition source", () => {
    const first = createFulfillmentSourceIdentity({
      siteId: "site-a",
      sourceType: "redemption",
      sourceRef: "code-42",
      purpose: "acquisition",
      cycleKey: "once",
    });
    const replay = createFulfillmentSourceIdentity({
      siteId: "site-a",
      sourceType: "redemption",
      sourceRef: "code-42",
      purpose: "acquisition",
      cycleKey: "once",
    });

    expect(first).toEqual(replay);
    expect(first.idempotencyKey).toMatch(/^[a-f0-9]{64}$/u);
    expect(createFulfillmentSourceIdentity({ ...first, siteId: "site-b" }).idempotencyKey)
      .not.toBe(first.idempotencyKey);
    expect(createFulfillmentSourceIdentity({ ...first, sourceType: "payment" }).idempotencyKey)
      .not.toBe(first.idempotencyKey);
    expect(createFulfillmentSourceIdentity({ ...first, sourceRef: "payment-42" }).idempotencyKey)
      .not.toBe(first.idempotencyKey);
  });

  it("requires a frozen pricing snapshot for payment acquisition", () => {
    expect(() => createFrozenFulfillmentSnapshot({
      sourceType: "payment",
      productVersionRef: "product-v1",
      planVersionRef: "plan-v1",
      offeringVersionRef: "offer-v1",
      sourceVersion: 1n, sourceDigest: digest("b"), acquiredAt: "2026-07-30T02:00:00.000Z",
      fulfillmentProgramRevisionRef: "fulfillment-v1", fulfillmentProgramRevision: 1n,
      fulfillmentProgramDigest: digest("a"),
      pricingSnapshotRef: null,
    })).toThrow("PAYMENT_PRICING_SNAPSHOT_REQUIRED");

    expect(createFrozenFulfillmentSnapshot({
      sourceType: "payment",
      productVersionRef: "product-v1",
      planVersionRef: "plan-v1",
      offeringVersionRef: "offer-v1",
      sourceVersion: 1n, sourceDigest: digest("b"), acquiredAt: "2026-07-30T02:00:00.000Z",
      fulfillmentProgramRevisionRef: "fulfillment-v1", fulfillmentProgramRevision: 1n,
      fulfillmentProgramDigest: digest("a"),
      pricingSnapshotRef: "price-snapshot-v3",
    })).toMatchObject({ pricingSnapshotRef: "price-snapshot-v3" });
  });
});
