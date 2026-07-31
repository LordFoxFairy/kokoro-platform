import {
  ImageOperationWorker,
  MediaArtifactCleanupWorker,
  type ImageOutputTrustPort,
  type MediaArtifactCleanupRepository,
  type MediaArtifactStagedCleanupPort,
  type MediaImageArtifactPort,
  type MediaImageCreditSettlementPort,
  type MediaImageEffectPort,
  type MediaImageReceiptCanonicalizerPort,
  type MediaImageSessionProjectionPort,
  type MediaImageUsagePort,
  type MediaImageWorkerRepository,
} from "../modules/media/application/index.js";
import type { PlatformWorkerCycleContext } from "./worker.js";

export interface MediaWorkerApplicationComposition {
  runOneCycle(context: PlatformWorkerCycleContext): Promise<void>;
  stopClaiming(): Promise<void>;
  returnLeases(reason: "shutdown" | "shutdown-deadline" | "stop-claim-failed"): Promise<void>;
}

export function createMediaWorkerApplicationComposition(input: Readonly<{
  workerId: string;
  imageRepository: MediaImageWorkerRepository;
  effect: MediaImageEffectPort;
  artifact: MediaImageArtifactPort;
  trust: ImageOutputTrustPort;
  usage: MediaImageUsagePort;
  credit: MediaImageCreditSettlementPort;
  projection: MediaImageSessionProjectionPort;
  receipts: MediaImageReceiptCanonicalizerPort;
  cleanupRepository: MediaArtifactCleanupRepository;
  cleanup: MediaArtifactStagedCleanupPort;
}>): MediaWorkerApplicationComposition {
  for (const [name, adapter] of [["effect", input.effect], ["artifact", input.artifact],
    ["trust", input.trust], ["usage", input.usage], ["credit", input.credit],
    ["projection", input.projection], ["receipts", input.receipts], ["cleanup", input.cleanup],
    ["image-repository", input.imageRepository], ["cleanup-repository", input.cleanupRepository]] as const) {
    if (isDevelopmentOnly(adapter)) throw new Error(`MEDIA_WORKER_DEVELOPMENT_ADAPTER_FORBIDDEN:${name}`);
  }
  const image = new ImageOperationWorker({ repository: input.imageRepository, effect: input.effect,
    artifact: input.artifact, trust: input.trust, usage: input.usage, credit: input.credit,
    projection: input.projection, receipts: input.receipts, workerId: input.workerId });
  const cleanup = new MediaArtifactCleanupWorker({ repository: input.cleanupRepository,
    cleanup: input.cleanup, workerId: input.workerId });
  return Object.freeze({
    async runOneCycle(context: PlatformWorkerCycleContext): Promise<void> {
      const outcomes = await Promise.allSettled([image.runOneCycle(context), cleanup.runOneCycle(context)]);
      const failures = outcomes.filter((value): value is PromiseRejectedResult => value.status === "rejected");
      if (failures.length > 0) throw new AggregateError(failures.map((value) => value.reason),
        "MEDIA_WORKER_ACTIVITY_CYCLE_FAILED");
    },
    async stopClaiming(): Promise<void> { await Promise.all([image.stopClaiming(), cleanup.stopClaiming()]); },
    async returnLeases(reason: "shutdown" | "shutdown-deadline" | "stop-claim-failed"): Promise<void> {
      await Promise.all([image.returnLeases(reason), cleanup.returnLeases(reason)]);
    },
  });
}

export function assertMediaWorkerGeneratedContractsAvailable(input: Readonly<{
  imageEffectConnectClient: boolean;
  imageOutputDataPlaneClient: boolean;
  sessionProjectionClient: boolean;
  canonicalReceiptHelpers: boolean;
  capabilityEnvelopeOpener: boolean;
}>): void {
  const missing = [
    ["image-effect-connect", input.imageEffectConnectClient],
    ["image-output-data-plane", input.imageOutputDataPlaneClient],
    ["session-projection", input.sessionProjectionClient],
    ["canonical-receipts", input.canonicalReceiptHelpers],
    ["capability-envelope", input.capabilityEnvelopeOpener],
  ].filter((entry) => !entry[1]).map((entry) => entry[0]);
  if (missing.length > 0) throw new Error(`MEDIA_WORKER_PRODUCTION_CONTRACTS_UNAVAILABLE:${missing.join(",")}`);
}

function isDevelopmentOnly(value: unknown): boolean {
  return typeof value === "object" && value !== null && "developmentOnly" in value &&
    (value as { developmentOnly?: unknown }).developmentOnly === true;
}
