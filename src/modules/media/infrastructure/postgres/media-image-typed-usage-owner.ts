import { imageEffectUsageFactDigest, type ImageEffectUsageFact } from
  "../../../model-gateway/domain/image-effect.js";

export type MediaImageTypedUsageFactRow = Readonly<{
  attemptRef: string;
  usageEvidenceRef: string;
  usageEvidenceDigest: string;
  usageFact: unknown;
  recordedAt: Date | string;
}>;

export interface MediaImageTypedUsageFactDatabase {
  loadMediaImageEffectUsageFact(input: Readonly<{
    operationRef: string;
    modelInvocationCommandRef: string;
    logicalInvocationRef: string;
    usageEvidenceRef: string;
    usageEvidenceDigest: string;
  }>): Promise<readonly MediaImageTypedUsageFactRow[]>;
}

/** Exact owner lookup; absence is a reconciliation state, never implicit zero usage. */
export class PostgresMediaImageTypedUsageFactOwner {
  constructor(private readonly database: MediaImageTypedUsageFactDatabase) {}

  async loadCertified(input: Parameters<MediaImageTypedUsageFactDatabase["loadMediaImageEffectUsageFact"]>[0]):
  Promise<Readonly<{ kind: "available"; attemptRef: string; fact: ImageEffectUsageFact }> |
    Readonly<{ kind: "reconciliation_required"; code: "TYPED_USAGE_FACT_UNAVAILABLE" }>> {
    for (const value of [input.operationRef, input.modelInvocationCommandRef, input.logicalInvocationRef,
      input.usageEvidenceRef]) reference(value);
    digest(input.usageEvidenceDigest);
    const rows = await this.database.loadMediaImageEffectUsageFact(input);
    if (rows.length === 0) {
      return Object.freeze({ kind: "reconciliation_required" as const,
        code: "TYPED_USAGE_FACT_UNAVAILABLE" as const });
    }
    if (rows.length !== 1) throw new Error("MEDIA_TYPED_USAGE_FACT_AMBIGUOUS");
    const row = rows[0]!;
    if (row.usageEvidenceRef !== input.usageEvidenceRef ||
        row.usageEvidenceDigest !== input.usageEvidenceDigest) {
      throw new Error("MEDIA_TYPED_USAGE_FACT_BINDING_INVALID");
    }
    reference(row.attemptRef);
    instant(row.recordedAt);
    const fact = parseFact(row.usageFact);
    if (imageEffectUsageFactDigest(fact) !== row.usageEvidenceDigest) {
      throw new Error("MEDIA_TYPED_USAGE_FACT_DIGEST_MISMATCH");
    }
    return Object.freeze({ kind: "available" as const, attemptRef: row.attemptRef, fact });
  }
}

function parseFact(value: unknown): ImageEffectUsageFact {
  if (!record(value) || !["measured", "zero", "unavailable"].includes(String(value.evidenceKind)) ||
      !["succeeded", "failed_after_effect", "canceled_after_effect"].includes(String(value.attemptOutcome)) ||
      typeof value.occurredAt !== "string" || typeof value.sourceDigest !== "string" ||
      !Array.isArray(value.dimensions) || value.dimensions.length > 64) {
    throw new Error("MEDIA_TYPED_USAGE_FACT_INVALID");
  }
  instant(value.occurredAt); digest(value.sourceDigest);
  const dimensionKeys = new Set<string>();
  const dimensions = Object.freeze(value.dimensions.map((raw) => {
    if (!record(raw) || typeof raw.dimensionKey !== "string" || typeof raw.sourceUnit !== "string" ||
        typeof raw.quantity !== "string" || !/^(0|[1-9][0-9]{0,37})$/u.test(raw.quantity) ||
        dimensionKeys.has(raw.dimensionKey)) {
      throw new Error("MEDIA_TYPED_USAGE_FACT_INVALID");
    }
    usageKey(raw.dimensionKey); usageKey(raw.sourceUnit);
    dimensionKeys.add(raw.dimensionKey);
    return Object.freeze({ dimensionKey: raw.dimensionKey, sourceUnit: raw.sourceUnit,
      quantity: BigInt(raw.quantity) });
  }));
  const evidenceKind = value.evidenceKind as ImageEffectUsageFact["evidenceKind"];
  const unavailableReasonCode = value.unavailableReasonCode;
  if ((evidenceKind === "measured") !== (dimensions.length > 0) ||
      (evidenceKind === "unavailable") !== (typeof unavailableReasonCode === "string") ||
      (typeof unavailableReasonCode === "string" && !/^[A-Z0-9_]{1,128}$/u.test(unavailableReasonCode))) {
    throw new Error("MEDIA_TYPED_USAGE_FACT_INVALID");
  }
  return Object.freeze({ evidenceKind, dimensions,
    attemptOutcome: value.attemptOutcome as ImageEffectUsageFact["attemptOutcome"],
    occurredAt: value.occurredAt, sourceDigest: value.sourceDigest,
    ...(typeof unavailableReasonCode === "string" ? { unavailableReasonCode } : {}) });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function reference(value: string): void {
  if (value.length < 1 || value.length > 256 || value.trim() !== value || /[\0\r\n]/u.test(value)) {
    throw new Error("MEDIA_TYPED_USAGE_FACT_INVALID");
  }
}
function digest(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error("MEDIA_TYPED_USAGE_FACT_INVALID");
}
function usageKey(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(value)) {
    throw new Error("MEDIA_TYPED_USAGE_FACT_INVALID");
  }
}
function instant(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("MEDIA_TYPED_USAGE_FACT_INVALID");
  return parsed.toISOString();
}
