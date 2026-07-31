import { vi } from "vitest";
import type {
  MediaImageArtifactPort,
  MediaImageReceiptCanonicalizerPort,
} from "../../../src/modules/media/application/image-operation-worker.js";

export function artifactPort(events: string[]): MediaImageArtifactPort {
  return {
    issueRecoverReadAndStageOutput: vi.fn(async (input) => {
      events.push("artifact.owner.stage");
      return { ownerScope: input.ownerScope, artifactRef: input.artifactRef,
        artifactVersionRef: input.artifactVersionRef,
        stagedObjectRef: `staged:${input.outputEvidenceRef}`,
        contentSha256: "a".repeat(64), byteSize: 1n, mediaType: input.expectedMediaType,
        state: "staged" as const };
    }),
    promote: vi.fn(async (input) => {
      events.push("artifact.owner.promote");
      return { ownerScope: input.stagedReceipt.ownerScope, artifactRef: input.stagedReceipt.artifactRef,
        artifactVersionRef: input.stagedReceipt.artifactVersionRef,
        readyObjectRef: `ready:${input.stagedReceipt.contentSha256}`,
        contentSha256: input.stagedReceipt.contentSha256, byteSize: input.stagedReceipt.byteSize,
        mediaType: input.stagedReceipt.mediaType, trustDecisionRef: input.trustDecision.decisionRef,
        stagedCleanup: { state: "completed" as const }, state: "ready_private" as const };
    }),
  };
}

export function receiptPort(): MediaImageReceiptCanonicalizerPort {
  return {
    artifactFinalization: (receipt) => `artifact-finalization:${receipt.artifactVersionRef}`,
    effectClosure: (input) => `media-effect-closure:${input.state}:${input.operationRef}`,
    finalTerminal: (input) => `media-terminal:${input.state}:${input.operationRef}:${input.financial.financialReceiptRef}`,
  };
}
