import { describe, expect, it, vi } from "vitest";
import {
  assertMediaWorkerGeneratedContractsAvailable,
  createMediaWorkerApplicationComposition,
} from "../../src/process/media-worker-composition.js";
import { PLATFORM_MEDIA_WORKER_DEPLOYMENT_CONTRACT } from
  "../../src/process/worker-deployment-contract.js";
import { InMemoryMediaImageWorkerRepository } from
  "../../src/modules/media/application/image-operation-worker.js";
import { DeterministicDevelopmentImageProviderAdapter } from
  "../../src/modules/media/infrastructure/dev/deterministic-image-provider.js";
import { artifactPort, receiptPort } from "./helpers/media-image-worker-fakes.js";

describe("Media worker production composition", () => {
  it("rejects development-only effect adapters", () => {
    const events: string[] = [];
    expect(() => createMediaWorkerApplicationComposition({
      workerId: "worker:one", imageRepository: new InMemoryMediaImageWorkerRepository(),
      effect: new DeterministicDevelopmentImageProviderAdapter(events), artifact: artifactPort(events),
      trust: { evaluate: async (input) => ({ kind: "allow", decisionRef: "trust:one",
        contentSha256: input.contentSha256 }) },
      usage: { recordAttempt: async () => ({ attemptUsageEvidenceReceiptRef: "usage:one" }) },
      credit: { finalizeBudget: async () => ({ kind: "settled", financialReceiptRef: "financial:one",
        allocationClosureReceiptRef: "allocation-closure:one", actualCost: "80",
        refundedCredit: "20", unit: "credit" }) },
      projection: { publish: async () => ({ projectionReceiptRef: "projection:one" }) },
      receipts: receiptPort(), cleanupRepository: cleanupRepository(),
      cleanup: { cleanupStaged: async () => undefined },
    })).toThrow("MEDIA_WORKER_DEVELOPMENT_ADAPTER_FORBIDDEN:effect");
  });

  it("fails launch while Root generated clients and receipt helpers are unavailable", () => {
    expect(() => assertMediaWorkerGeneratedContractsAvailable({
      imageEffectConnectClient: false, imageOutputDataPlaneClient: false,
      sessionProjectionClient: false, canonicalReceiptHelpers: false,
      capabilityEnvelopeOpener: false,
    })).toThrow("MEDIA_WORKER_PRODUCTION_CONTRACTS_UNAVAILABLE:image-effect-connect,image-output-data-plane,session-projection,canonical-receipts,capability-envelope");
  });

  it("declares one Model Gateway boundary plus direct private object storage", () => {
    expect(PLATFORM_MEDIA_WORKER_DEPLOYMENT_CONTRACT.environment.required).toContain(
      "PLATFORM_ARTIFACT_STORAGE_ROUTE_FILE",
    );
    expect(PLATFORM_MEDIA_WORKER_DEPLOYMENT_CONTRACT.outboundContracts).toEqual([
      "model-gateway-image-effect-connectrpc", "s3-object-api", "session-media-projection-connectrpc",
    ]);
    expect(PLATFORM_MEDIA_WORKER_DEPLOYMENT_CONTRACT.environment.required).not.toContain(
      "PLATFORM_ARTIFACT_SOURCE_ENDPOINT",
    );
  });
});

function cleanupRepository() {
  return { claim: vi.fn(async () => null), renewLease: vi.fn(async () => undefined),
    complete: vi.fn(async () => undefined), retryOrDeadLetter: vi.fn(async () => "retry" as const),
    releaseOwnedLeases: vi.fn(async () => undefined) };
}
