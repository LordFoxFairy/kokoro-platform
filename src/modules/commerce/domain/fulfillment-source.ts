import { createHash } from "node:crypto";
import { commerceCanonicalJson } from "./canonical-json.js";

const SHA256 = /^[a-f0-9]{64}$/u;

export type FulfillmentSourceType = "redemption" | "payment" | "admin_grant" | "program_window";

export type FulfillmentSourceIdentity = Readonly<{
  siteId: string;
  sourceType: FulfillmentSourceType;
  sourceRef: string;
  purpose: string;
  cycleKey: string;
  idempotencyKey: string;
}>;

export type FrozenFulfillmentSnapshot = Readonly<{
  productVersionRef: string;
  planVersionRef: string | null;
  offeringVersionRef: string;
  fulfillmentProgramVersionRef: string;
  outputPlanDigest: string;
  acquisitionSnapshotDigest: string;
  pricingSnapshotRef: string | null;
}>;

export function createFulfillmentSourceIdentity(input: Readonly<{
  siteId: string;
  sourceType: FulfillmentSourceType;
  sourceRef: string;
  purpose: string;
  cycleKey: string;
}>): FulfillmentSourceIdentity {
  const siteId = bounded(input.siteId, 256, "FULFILLMENT_SITE_INVALID");
  const sourceRef = bounded(input.sourceRef, 256, "FULFILLMENT_SOURCE_REF_INVALID");
  const purpose = bounded(input.purpose, 128, "FULFILLMENT_PURPOSE_INVALID");
  const cycleKey = bounded(input.cycleKey, 128, "FULFILLMENT_CYCLE_KEY_INVALID");
  if (!["redemption", "payment", "admin_grant", "program_window"].includes(input.sourceType)) {
    throw new Error("FULFILLMENT_SOURCE_TYPE_INVALID");
  }
  const idempotencyKey = createHash("sha256").update(commerceCanonicalJson({
    version: 1,
    siteId,
    sourceType: input.sourceType,
    sourceRef,
    purpose,
    cycleKey,
  }), "utf8").digest("hex");
  return Object.freeze({ siteId, sourceType: input.sourceType, sourceRef, purpose, cycleKey, idempotencyKey });
}

export function createFrozenFulfillmentSnapshot(input: FrozenFulfillmentSnapshot & Readonly<{
  sourceType: FulfillmentSourceType;
}>): FrozenFulfillmentSnapshot {
  const snapshot = Object.freeze({
    productVersionRef: bounded(input.productVersionRef, 256, "FULFILLMENT_PRODUCT_VERSION_INVALID"),
    planVersionRef: input.planVersionRef === null
      ? null
      : bounded(input.planVersionRef, 256, "FULFILLMENT_PLAN_VERSION_INVALID"),
    offeringVersionRef: bounded(input.offeringVersionRef, 256, "FULFILLMENT_OFFERING_VERSION_INVALID"),
    fulfillmentProgramVersionRef: bounded(
      input.fulfillmentProgramVersionRef,
      256,
      "FULFILLMENT_PROGRAM_VERSION_INVALID",
    ),
    outputPlanDigest: sha256(input.outputPlanDigest, "FULFILLMENT_OUTPUT_PLAN_DIGEST_INVALID"),
    acquisitionSnapshotDigest: sha256(
      input.acquisitionSnapshotDigest,
      "FULFILLMENT_ACQUISITION_SNAPSHOT_DIGEST_INVALID",
    ),
    pricingSnapshotRef: input.pricingSnapshotRef === null
      ? null
      : bounded(input.pricingSnapshotRef, 256, "FULFILLMENT_PRICING_SNAPSHOT_INVALID"),
  });
  if (input.sourceType === "payment" && snapshot.pricingSnapshotRef === null) {
    throw new Error("PAYMENT_PRICING_SNAPSHOT_REQUIRED");
  }
  return snapshot;
}

function bounded(value: string, maximum: number, code: string): string {
  if (value.length < 1 || value.length > maximum || [...value].some((character) => character.codePointAt(0)! < 32)) {
    throw new Error(code);
  }
  return value;
}

function sha256(value: string, code: string): string {
  if (!SHA256.test(value)) throw new Error(code);
  return value;
}
