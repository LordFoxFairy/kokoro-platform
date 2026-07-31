import { describe, expect, it, vi } from "vitest";
import { PostgresMediaImageTypedUsageFactOwner } from
  "../../src/modules/media/infrastructure/postgres/media-image-typed-usage-owner.js";
import { imageEffectUsageFactDigest } from
  "../../src/modules/model-gateway/domain/image-effect.js";

const fact = Object.freeze({ evidenceKind: "measured" as const,
  dimensions: Object.freeze([Object.freeze({ dimensionKey: "image", sourceUnit: "output", quantity: 1n })]),
  attemptOutcome: "succeeded" as const, occurredAt: "2026-07-31T12:00:00.000Z",
  sourceDigest: "b".repeat(64) });
const input = Object.freeze({ taskRef: "media-task:one", leaseEpoch: 1n, leaseTokenHash: "d".repeat(64),
  operationRef: "media-operation:one",
  modelInvocationCommandRef: "model-command:one", logicalInvocationRef: "logical-invocation:one",
  usageEvidenceRef: "usage-evidence:one", usageEvidenceDigest: imageEffectUsageFactDigest(fact) });
const attemptAuthorization = Object.freeze({
  attemptAuthorizationRef: "00000000-0000-7000-8000-000000000111",
  attemptAuthorizationFenceEpoch: 1n,
  attemptAuthorizationDigest: "7".repeat(64),
});
const attemptIdentity = Object.freeze({ authorizationSegmentRef: "00000000-0000-7000-8000-000000000222",
  executionManifestRef: "manifest:one", producerKind: "model_gateway" as const,
  producerContext: "model-gateway:image", producerGeneration: 1n,
  logicalEffectRef: input.logicalInvocationRef });

describe("PostgresMediaImageTypedUsageFactOwner", () => {
  it("loads one exact Model Gateway usage fact and restores integer dimensions", async () => {
    const database = { loadMediaImageEffectUsageFact: vi.fn(async () => [{ attemptRef: "attempt:one",
      attemptAuthorizationRef: attemptAuthorization.attemptAuthorizationRef,
      attemptAuthorizationFenceEpoch: "1",
      attemptAuthorizationDigest: attemptAuthorization.attemptAuthorizationDigest,
      ...attemptIdentity,
      usageEvidenceRef: input.usageEvidenceRef, usageEvidenceDigest: input.usageEvidenceDigest,
      usageFact: { evidenceKind: "measured", dimensions: [{ dimensionKey: "image", sourceUnit: "output",
        quantity: "1" }], attemptOutcome: "succeeded", occurredAt: "2026-07-31T12:00:00.000Z",
        sourceDigest: "b".repeat(64) }, recordedAt: "2026-07-31T12:00:01.000Z" }]) };

    await expect(new PostgresMediaImageTypedUsageFactOwner(database).loadCertified(input)).resolves.toEqual({
      kind: "available", attemptRef: "attempt:one", ...attemptAuthorization, ...attemptIdentity, fact: {
        evidenceKind: "measured", dimensions: [{ dimensionKey: "image", sourceUnit: "output", quantity: 1n }],
        attemptOutcome: "succeeded", occurredAt: "2026-07-31T12:00:00.000Z",
        sourceDigest: "b".repeat(64),
      },
    });
  });

  it("returns reconciliation_required when no typed fact exists and never invents zero usage", async () => {
    const database = { loadMediaImageEffectUsageFact: vi.fn(async () => []) };
    await expect(new PostgresMediaImageTypedUsageFactOwner(database).loadCertified(input)).resolves.toEqual({
      kind: "reconciliation_required", code: "TYPED_USAGE_FACT_UNAVAILABLE",
    });
  });

  it("rejects a typed fact whose persisted JSON is not bound by the owner digest", async () => {
    const database = { loadMediaImageEffectUsageFact: vi.fn(async () => [{ attemptRef: "attempt:one",
      attemptAuthorizationRef: attemptAuthorization.attemptAuthorizationRef,
      attemptAuthorizationFenceEpoch: "1",
      attemptAuthorizationDigest: attemptAuthorization.attemptAuthorizationDigest,
      ...attemptIdentity,
      usageEvidenceRef: input.usageEvidenceRef, usageEvidenceDigest: input.usageEvidenceDigest,
      usageFact: { evidenceKind: "measured", dimensions: [{ dimensionKey: "image", sourceUnit: "output",
        quantity: "2" }], attemptOutcome: "succeeded", occurredAt: fact.occurredAt,
        sourceDigest: fact.sourceDigest }, recordedAt: "2026-07-31T12:00:01.000Z" }]) };
    await expect(new PostgresMediaImageTypedUsageFactOwner(database).loadCertified(input))
      .rejects.toThrow("MEDIA_TYPED_USAGE_FACT_DIGEST_MISMATCH");
  });

  it("rejects duplicate rating dimensions even when the persisted digest binds them", async () => {
    const duplicated = Object.freeze({ ...fact, dimensions: Object.freeze([
      fact.dimensions[0]!, Object.freeze({ ...fact.dimensions[0]!, quantity: 2n }),
    ]) });
    const duplicatedInput = Object.freeze({ ...input,
      usageEvidenceDigest: imageEffectUsageFactDigest(duplicated) });
    const database = { loadMediaImageEffectUsageFact: vi.fn(async () => [{ attemptRef: "attempt:one",
      attemptAuthorizationRef: attemptAuthorization.attemptAuthorizationRef,
      attemptAuthorizationFenceEpoch: "1",
      attemptAuthorizationDigest: attemptAuthorization.attemptAuthorizationDigest,
      ...attemptIdentity,
      usageEvidenceRef: duplicatedInput.usageEvidenceRef,
      usageEvidenceDigest: duplicatedInput.usageEvidenceDigest,
      usageFact: { evidenceKind: "measured", dimensions: [
        { dimensionKey: "image", sourceUnit: "output", quantity: "1" },
        { dimensionKey: "image", sourceUnit: "output", quantity: "2" },
      ], attemptOutcome: "succeeded", occurredAt: fact.occurredAt,
      sourceDigest: fact.sourceDigest }, recordedAt: "2026-07-31T12:00:01.000Z" }]) };

    await expect(new PostgresMediaImageTypedUsageFactOwner(database).loadCertified(duplicatedInput))
      .rejects.toThrow("MEDIA_TYPED_USAGE_FACT_INVALID");
  });

  it("returns reconciliation_required for an ambiguous owner lookup instead of selecting a fact", async () => {
    const row = { attemptRef: "attempt:one", attemptAuthorizationRef: attemptAuthorization.attemptAuthorizationRef,
      attemptAuthorizationFenceEpoch: "1", usageEvidenceRef: input.usageEvidenceRef,
      attemptAuthorizationDigest: attemptAuthorization.attemptAuthorizationDigest,
      ...attemptIdentity,
      usageEvidenceDigest: input.usageEvidenceDigest, usageFact: { evidenceKind: "measured",
        dimensions: [{ dimensionKey: "image", sourceUnit: "output", quantity: "1" }],
        attemptOutcome: "succeeded", occurredAt: fact.occurredAt, sourceDigest: fact.sourceDigest },
      recordedAt: "2026-07-31T12:00:01.000Z" };
    const database = { loadMediaImageEffectUsageFact: vi.fn(async () => [row, row]) };
    await expect(new PostgresMediaImageTypedUsageFactOwner(database).loadCertified(input)).resolves.toEqual({
      kind: "reconciliation_required", code: "TYPED_USAGE_FACT_AMBIGUOUS",
    });
  });
});
