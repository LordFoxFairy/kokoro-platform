import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ImageEffectEvidenceService } from
  "../../src/modules/model-gateway/application/image-effect-evidence-service.js";
import type { ImageEffectAccessAuthorization, ImageEffectUnitOfWork, ImageEffectView } from
  "../../src/modules/model-gateway/application/image-effect-service.js";

const ACCESS = "h".repeat(32);
const AUTHORIZATION: ImageEffectAccessAuthorization = Object.freeze({
  callerAccessHandleDigest: createHash("sha256").update(ACCESS).digest("hex"),
  callerIdentity: "platform-media-worker:one",
  siteId: "site:one",
  callerAudience: "platform-media-worker",
  workloadIdentityRef: "spiffe://kokoro/platform-media-worker",
  environment: "test",
  region: "local",
  authorizationGeneration: 1n,
  securityEpoch: 1n,
  accessExpiresAt: "2030-01-01T00:00:00.000Z",
  sourceGrantClaims: [],
});

const VIEW: ImageEffectView = Object.freeze({
  logicalInvocationRef: "invocation:one",
  modelInvocationCommandRef: "command:one",
  ownerVersion: 7n,
  currentAttemptOrdinal: 1,
  state: "succeeded",
  observedAt: "2026-07-31T12:00:00.000Z",
});

describe("ImageEffectEvidenceService", () => {
  it("authorizes the exact owner, rejects a future cursor and returns an exact high-water page", async () => {
    const readPage = vi.fn(async () => Object.freeze({
      invocation: VIEW,
      ownerHighWatermark: 3n,
      facts: Object.freeze([
        Object.freeze({ logicalInvocationRef: "invocation:one", attemptRef: "attempt:one",
          evidenceSequence: 2n, ownerVersion: 7n, kind: "usage" as const,
          evidenceRef: "usage:one", evidenceDigest: "b".repeat(64),
          recordedAt: "2026-07-31T12:00:00.000Z" }),
        Object.freeze({ logicalInvocationRef: "invocation:one", attemptRef: "attempt:one",
          evidenceSequence: 3n, ownerVersion: 7n, kind: "output" as const,
          evidenceRef: "output:one", evidenceDigest: "c".repeat(64),
          recordedAt: "2026-07-31T12:00:00.000Z",
          output: Object.freeze({ candidateOrdinal: 1, candidateRef: "candidate:one",
            stableOutputSlotRef: "slot:one", outputEvidenceRef: "output:one",
            outputEvidenceDigest: "c".repeat(64), providerOutputFactRef: "provider-output:one",
            retrievalGrantHandleDigest: "d".repeat(64), mediaType: "image/png" as const,
            width: 1024, height: 1024, declaredByteSize: 4096n }) }),
      ]),
    }));
    const service = new ImageEffectEvidenceService({ unitOfWork: unitOfWork(), repository: { readPage },
      clock: () => new Date("2026-07-31T12:00:00.000Z") });

    const page = await service.get({ callerAccessHandle: ACCESS, logicalInvocationRef: "invocation:one",
      afterEvidenceSequence: 1n, limit: 2 });

    expect(readPage).toHaveBeenCalledWith(expect.anything(), {
      callerIdentity: "platform-media-worker:one", logicalInvocationRef: "invocation:one",
      afterEvidenceSequence: 1n, limit: 2,
    });
    expect(page).toMatchObject({ invocation: VIEW, nextEvidenceSequence: 3n, caughtUp: true });
    await expect(service.get({ callerAccessHandle: ACCESS, logicalInvocationRef: "invocation:one",
      afterEvidenceSequence: 4n, limit: 2 })).rejects.toThrow("IMAGE_EFFECT_EVIDENCE_CURSOR_INVALID");
  });

  it("fails closed when the ledger does not belong to the requested invocation", async () => {
    const service = new ImageEffectEvidenceService({ unitOfWork: unitOfWork(), repository: {
      readPage: async () => Object.freeze({ invocation: VIEW, ownerHighWatermark: 1n,
        facts: Object.freeze([{ logicalInvocationRef: "invocation:other", attemptRef: "attempt:one",
          evidenceSequence: 1n, ownerVersion: 7n, kind: "outcome" as const,
          evidenceRef: "outcome:one", evidenceDigest: "a".repeat(64),
          recordedAt: "2026-07-31T12:00:00.000Z" }]) }),
    }, clock: () => new Date("2026-07-31T12:00:00.000Z") });
    await expect(service.get({ callerAccessHandle: ACCESS, logicalInvocationRef: "invocation:one",
      afterEvidenceSequence: 0n, limit: 1 })).rejects.toThrow("IMAGE_EFFECT_EVIDENCE_LEDGER_CORRUPT");
  });
});

function unitOfWork(): ImageEffectUnitOfWork {
  return Object.freeze({
    execute: async <Result>(_scope: Parameters<ImageEffectUnitOfWork["execute"]>[0],
      work: Parameters<ImageEffectUnitOfWork["execute"]>[1]): Promise<Result> =>
      work(Object.freeze({}) as never, AUTHORIZATION) as Promise<Result>,
  });
}
