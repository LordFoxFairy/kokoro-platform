import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { commerceCanonicalJson } from "./canonical-json.js";

export const redemptionSafeTermsSchema = z.strictObject({
  productRef: z.string().min(1).max(256),
  productVersionRef: z.string().min(1).max(256),
  productKind: z.enum(["free", "credit_pack", "subscription", "bundle"]),
  safeProductLabel: z.string().min(1).max(160),
  planRef: z.string().max(256).nullable(),
  planVersionRef: z.string().max(256).nullable(),
  safePlanLabel: z.string().max(160).nullable(),
  term: z.strictObject({
    action: z.enum(["none", "new_subscription", "extend_from_max", "reject_if_active"]),
    startsAt: z.iso.datetime().nullable(),
    endsAt: z.iso.datetime().nullable(),
    automaticRenewal: z.literal(false),
  }),
  credits: z.array(z.strictObject({
    creditProgramRevisionRef: z.string().min(1).max(256),
    bucketClass: z.enum(["daily", "period", "permanent"]),
    unit: z.string().min(1).max(64),
    amount: z.string().regex(/^(?:0|[1-9][0-9]{0,37})$/u),
    expiresAt: z.iso.datetime().nullable(),
  })).max(64),
  entitlements: z.array(z.strictObject({
    entitlementTemplateRevisionRef: z.string().min(1).max(256),
    capabilityKey: z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/u),
    safeLabel: z.string().min(1).max(160),
    expiresAt: z.iso.datetime().nullable(),
  })).max(128),
  legalTermRefs: z.array(z.string().min(1).max(128)).max(16),
});

export type RedemptionSafeTerms = z.infer<typeof redemptionSafeTermsSchema>;

/**
 * Redemption is intentionally limited to one-shot, non-expiring credit packs in
 * this release. Daily/period programs require a calendar-window acquisition
 * authority and must not be approximated with a relative expiry grant.
 */
export const redemptionReleaseCapabilities = Object.freeze({
  creditGrantBucketClasses: Object.freeze(["permanent"] as const),
  calendarWindowCreditAcquisition: false,
});

export function isSupportedRedemptionSafeTerms(terms: RedemptionSafeTerms): boolean {
  return terms.credits.every((credit) => credit.bucketClass === "permanent" && credit.expiresAt === null);
}

export class RedemptionPolicyError extends Error {
  constructor() {
    super("REDEMPTION_POLICY_REJECTED");
    this.name = "RedemptionPolicyError";
  }
}

export interface RedemptionPreviewCandidate {
  readonly codeRef: string;
  readonly batchRef: string;
  readonly redemptionProgramRevisionRef: string;
  readonly fulfillmentProgramRevisionRef: string;
  readonly productRevisionDigest: string;
  readonly programDigest: string;
  readonly outputPlanDigest: string;
  readonly safeCodeFingerprint: string;
  readonly safeTerms: RedemptionSafeTerms;
}

export interface PublishedFulfillmentOutputLine {
  readonly outputLineId: string;
  readonly ordinal: number;
  readonly cardinality: number;
  readonly outputKind: "subscription_term" | "entitlement_grant" | "credit_grant";
  readonly planVersionRef: string | null;
  readonly entitlementTemplateRevisionRef: string | null;
  readonly creditProgramRevisionRef: string | null;
}

export function publishedFulfillmentOutputPlanDigest(input: Readonly<{
  siteId: string;
  fulfillmentProgramRevisionRef: string;
  lines: readonly PublishedFulfillmentOutputLine[];
}>): string {
  return createHash("sha256").update(commerceCanonicalJson({
    version: 1,
    siteId: input.siteId,
    fulfillmentProgramRevisionRef: input.fulfillmentProgramRevisionRef,
    lines: input.lines.map((line) => ({
      outputLineId: line.outputLineId,
      ordinal: line.ordinal,
      cardinality: line.cardinality,
      outputKind: line.outputKind,
      planVersionRef: line.planVersionRef,
      entitlementTemplateRevisionRef: line.entitlementTemplateRevisionRef,
      creditProgramRevisionRef: line.creditProgramRevisionRef,
    })),
  }), "utf8").digest("hex");
}

export interface StoredRedemptionPreview extends RedemptionPreviewCandidate {
  readonly previewRef: string;
  readonly commandId: string;
  readonly siteId: string;
  readonly subjectId: string;
  readonly subjectGeneration: string;
  readonly billingAccountId: string;
  readonly previewDigest: string;
  readonly credentialKeyRevision: string;
  readonly credentialDigest: string;
  readonly state: "live" | "consumed" | "expired";
  readonly expiresAt: string;
  readonly createdAt: string;
}

export function redemptionPreviewDigest(input: Readonly<{
  siteId: string;
  subjectId: string;
  subjectGeneration: string;
  billingAccountId: string;
  candidate: RedemptionPreviewCandidate;
  expiresAt: string;
}>): string {
  return createHash("sha256").update(commerceCanonicalJson({
    version: 1,
    siteId: input.siteId,
    subjectId: input.subjectId,
    subjectGeneration: input.subjectGeneration,
    billingAccountId: input.billingAccountId,
    codeRef: input.candidate.codeRef,
    batchRef: input.candidate.batchRef,
    redemptionProgramRevisionRef: input.candidate.redemptionProgramRevisionRef,
    fulfillmentProgramRevisionRef: input.candidate.fulfillmentProgramRevisionRef,
    productRevisionDigest: input.candidate.productRevisionDigest,
    programDigest: input.candidate.programDigest,
    outputPlanDigest: input.candidate.outputPlanDigest,
    safeTerms: input.candidate.safeTerms,
    expiresAt: input.expiresAt,
  }), "utf8").digest("hex");
}

export function uuidV7(now: number = Date.now(), entropy: Uint8Array = randomBytes(10)): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > 0xffffffffffff || entropy.byteLength < 10) {
    throw new Error("UUID_V7_INPUT_INVALID");
  }
  const bytes = Buffer.alloc(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = 0x70 | (entropy[0]! & 0x0f);
  bytes[7] = entropy[1]!;
  bytes[8] = 0x80 | (entropy[2]! & 0x3f);
  entropy.subarray(3, 10).forEach((value, index) => { bytes[index + 9] = value; });
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
