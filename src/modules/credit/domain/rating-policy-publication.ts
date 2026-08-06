import { createHash } from "node:crypto";
import {
  defineRatingPolicyRevision,
  type RatingPolicyRevision,
  type RatingRule,
  type UsageAttemptOutcome,
} from "./usage-rating.js";

type RatingRuleDocument = Readonly<Omit<RatingRule, "quantum" | "amountPerQuantum"> & {
  quantum: string;
  amountPerQuantum: string;
}>;

export type RatingPolicyDocument = Readonly<{
  ratingPolicyRevisionRef: string;
  customerUnit: string;
  chargeableAttemptOutcomes: readonly UsageAttemptOutcome[];
  minimumAmount: string;
  rules: readonly RatingRuleDocument[];
}>;

export type PublishedRatingPolicyRevision = Readonly<{
  siteId: string;
  ratingPolicyRevisionRef: string;
  unit: string;
  policyDocument: RatingPolicyDocument;
  policyDigest: string;
  state: "published";
  publishedAt: string;
}>;

export function definePublishedRatingPolicyRevision(input: Readonly<{
  siteId: string;
  policy: RatingPolicyRevision;
  publishedAt: string;
}>): PublishedRatingPolicyRevision {
  siteReference(input.siteId);
  if (!Number.isFinite(Date.parse(input.publishedAt))) {
    throw new Error("CREDIT_RATING_POLICY_PUBLISHED_AT_INVALID");
  }
  const policy = defineRatingPolicyRevision(input.policy);
  decimal38(policy.minimumAmount, true);
  const policyDocument: RatingPolicyDocument = Object.freeze({
    ratingPolicyRevisionRef: policy.ratingPolicyRevisionRef,
    customerUnit: policy.customerUnit,
    chargeableAttemptOutcomes: Object.freeze([...policy.chargeableAttemptOutcomes]),
    minimumAmount: policy.minimumAmount.toString(),
    rules: Object.freeze(policy.rules.map((rule) => {
      decimal38(rule.quantum, false);
      decimal38(rule.amountPerQuantum, true);
      return Object.freeze({
        dimensionKey: rule.dimensionKey,
        sourceUnit: rule.sourceUnit,
        quantum: rule.quantum.toString(),
        amountPerQuantum: rule.amountPerQuantum.toString(),
        required: rule.required,
      });
    })),
  });
  return Object.freeze({
    siteId: input.siteId,
    ratingPolicyRevisionRef: policy.ratingPolicyRevisionRef,
    unit: policy.customerUnit,
    policyDocument,
    policyDigest: createHash("sha256")
      .update(canonicalRatingPolicyJson(policyDocument), "utf8").digest("hex"),
    state: "published",
    publishedAt: new Date(input.publishedAt).toISOString(),
  });
}

export function canonicalRatingPolicyJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("CREDIT_RATING_POLICY_JSON_INVALID");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalRatingPolicyJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, item]) =>
      `${JSON.stringify(key)}:${canonicalRatingPolicyJson(item)}`).join(",")}}`;
  }
  throw new Error("CREDIT_RATING_POLICY_JSON_INVALID");
}

function decimal38(value: bigint, allowZero: boolean): void {
  if ((allowZero ? value < 0n : value <= 0n) || value.toString().length > 38) {
    throw new Error("CREDIT_RATING_POLICY_DECIMAL_INVALID");
  }
}

function siteReference(value: string): void {
  if (value.length < 1 || value.length > 256 || [...value].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point < 32 || point === 127;
  })) throw new Error("CREDIT_RATING_POLICY_SITE_INVALID");
}
