import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ImageEffectOutputService, type ImageEffectOutputAccessRecord,
  type ImageEffectOutputRepository, type ImageEffectOutputSourceReader } from
  "../../src/modules/model-gateway/application/image-effect-output-service.js";
import type { ImageEffectAccessAuthorization, ImageEffectUnitOfWork } from
  "../../src/modules/model-gateway/application/image-effect-service.js";
import { createGeneratedImageEffectCommandDigestAuthority } from
  "../../src/modules/model-gateway/interfaces/connect/image-effect-connect-service.js";

const HANDLE = "h".repeat(32);
const AUTHORIZATION: ImageEffectAccessAuthorization = Object.freeze({
  callerAccessHandleDigest: sha256(HANDLE), callerIdentity: "platform-media-worker:one", siteId: "site:one",
  callerAudience: "platform-media-worker", workloadIdentityRef: "spiffe://kokoro/platform-media-worker",
  environment: "test", region: "local", authorizationGeneration: 7n, securityEpoch: 11n,
  accessExpiresAt: "2026-08-01T12:00:00.000Z", sourceGrantClaims: [],
});

describe("image-effect output capability owner", () => {
  it("journals one short-lived evidence-bound sealed capability and recovers the exact same issue", async () => {
    const records = new Map<string, ImageEffectOutputAccessRecord>();
    const repository = memoryRepository(records);
    const digest = createGeneratedImageEffectCommandDigestAuthority();
    const service = serviceWith(repository);
    const effect = { logicalInvocationRef: "invocation:one", outputEvidenceRef: "output-evidence:one",
      outputEvidenceDigest: "a".repeat(64) };
    const issued = await service.issue({ callerAccessHandle: HANDLE, outputAccessCommandRef: "output-command:one",
      ...effect, callerRequestFingerprint: digest.issueOutput(effect, AUTHORIZATION) });

    expect(issued.outputAccess).toEqual({ outputEvidenceRef: "output-evidence:one",
      outputEvidenceDigest: "a".repeat(64), sourceAccessHandle: "sealed-source-token:" + "s".repeat(32),
      sourceAccessExpiresAt: "2026-07-31T12:02:00.000Z", maxReadableBytes: 4096n });
    expect(issued.receipt.kind).toBe("output_access_issued");
    const recovered = await service.recover({ callerAccessHandle: HANDLE,
      outputAccessCommandRef: "output-command:one" });
    expect(recovered).toEqual({ ...issued, replayed: true });
  });

  it("streams a bounded range with contiguous offsets and exact chunk digests", async () => {
    const service = serviceWith(memoryRepository(new Map()), {
      readRange: async function* () {
        yield Object.freeze({ offset: 2n, data: Uint8Array.from([1, 2, 3]), eof: false });
        yield Object.freeze({ offset: 5n, data: Uint8Array.from([4, 5]), eof: true });
      },
    });
    const frames = [];
    for await (const frame of service.read({ sourceAccessHandle: "sealed-source-token:" + "s".repeat(32),
      outputEvidenceRef: "output-evidence:one", outputEvidenceDigest: "a".repeat(64), offset: 2n,
      maxBytes: 5, signal: new AbortController().signal })) frames.push(frame);
    expect(frames).toEqual([
      { offset: 2n, data: Uint8Array.from([1, 2, 3]), nextOffset: 5n, eof: false,
        chunkSha256: sha256Bytes(Uint8Array.from([1, 2, 3])) },
      { offset: 5n, data: Uint8Array.from([4, 5]), nextOffset: 7n, eof: true,
        chunkSha256: sha256Bytes(Uint8Array.from([4, 5])) },
    ]);
  });

  it("fails closed when an object reader exceeds the requested range", async () => {
    const service = serviceWith(memoryRepository(new Map()), {
      readRange: async function* () {
        yield { offset: 0n, data: new Uint8Array(5), eof: false };
      },
    });
    const consume = async () => {
      for await (const _frame of service.read({ sourceAccessHandle: "sealed-source-token:" + "s".repeat(32),
        outputEvidenceRef: "output-evidence:one", outputEvidenceDigest: "a".repeat(64), offset: 0n,
        maxBytes: 4, signal: new AbortController().signal })) { /* consume */ }
    };
    await expect(consume()).rejects.toThrow("IMAGE_EFFECT_OUTPUT_READER_PROTOCOL_INVALID");
  });
});

function serviceWith(
  repository: ImageEffectOutputRepository,
  objectReader: ImageEffectOutputSourceReader = {
    readRange: async function* () { yield { offset: 0n, data: Uint8Array.of(1), eof: true }; },
  },
) {
  const unitOfWork: ImageEffectUnitOfWork = {
    execute: async (_scope, work) => work({} as never, AUTHORIZATION),
  };
  return new ImageEffectOutputService({ unitOfWork, repository,
    commandDigest: createGeneratedImageEffectCommandDigestAuthority(),
    token: {
      issue: () => ({ sourceAccessHandle: "sealed-source-token:" + "s".repeat(32),
        sourceAccessHandleDigest: sha256("sealed-source-token:" + "s".repeat(32)),
        recoveryEnvelope: Object.freeze({ algorithm: "A256GCM", keyRevision: "test", nonce: "nonce",
          ciphertext: "recover", authenticationTag: "tag" }) }),
      recover: () => "sealed-source-token:" + "s".repeat(32),
      verify: () => Object.freeze({ capabilityRef: "output-capability:one", siteId: "site:one",
        callerIdentity: "platform-media-worker:one", audience: "platform-media-worker" as const,
        logicalInvocationRef: "invocation:one", outputEvidenceRef: "output-evidence:one",
        outputEvidenceDigest: "a".repeat(64), maxReadableBytes: 4096n,
        expiresAt: "2026-07-31T12:02:00.000Z", securityEpoch: 11n }),
    },
    objectReader,
    clock: () => new Date("2026-07-31T12:00:00.000Z"),
    reference: () => "output-capability:one", capabilityTtlMs: 120_000, maximumReadableBytes: 64n * 1024n * 1024n });
}

function memoryRepository(records: Map<string, ImageEffectOutputAccessRecord>): ImageEffectOutputRepository {
  return {
    lockCommand: async (_transaction, input) => records.get(input.outputAccessCommandRef) ?? null,
    lockEvidence: async () => Object.freeze({ logicalInvocationRef: "invocation:one", attemptRef: "attempt:one",
      attemptOrdinal: 1, outputEvidenceRef: "output-evidence:one", outputEvidenceDigest: "a".repeat(64),
      declaredByteSize: 4096n, providerOutputFactRef: "provider-output:one" }),
    create: async (_transaction, record) => { records.set(record.outputAccessCommandRef, record); },
    authorizeRead: async () => Object.freeze({ logicalInvocationRef: "invocation:one",
      outputEvidenceRef: "output-evidence:one", outputEvidenceDigest: "a".repeat(64),
      attemptRef: "attempt:one", attemptOrdinal: 1, declaredByteSize: 4096n,
      providerOutputFactRef: "provider-output:one" }),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
