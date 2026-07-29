import { randomUUID } from "node:crypto";
import type { JsonValue } from "../../../../shared/outbox-inbox/receipt.js";
import { createAssetPromotionIntent } from "../../domain/promotion-intent.js";
import { evaluateAssetScan } from "../../domain/scan-evaluation.js";
import { digestAssetCommand } from "../asset-digest.js";
import type { AssetWorkerUnitOfWorkPort } from "../contracts/asset-completion-worker-ports.js";
import type {
  AssetInspectionPolicyResolverPort,
  AssetScanWorkerRepositoryPort,
  AssetSecurityScannerPort,
  PersistedAssetScanDecision,
} from "../contracts/asset-scan-worker-ports.js";

export type ProcessAssetScanResult =
  | Readonly<{ disposition: "promotion_pending"; assetVersionRef: string }>
  | Readonly<{ disposition: "rejected" | "retry"; code: string }>
  | Readonly<{ disposition: "superseded" }>;

export class ProcessAssetScanService {
  constructor(private readonly dependencies: Readonly<{
    unitOfWork: AssetWorkerUnitOfWorkPort;
    repository: AssetScanWorkerRepositoryPort;
    policyResolver: AssetInspectionPolicyResolverPort;
    scanner: AssetSecurityScannerPort;
    reference?: () => string;
    clock?: () => Date;
  }>) {}

  async execute(input: Readonly<{
    eventId: string;
    siteRef: string;
    candidateRef: string;
    expectedVersion: bigint;
    correlationId: string;
  }>): Promise<ProcessAssetScanResult> {
    bounded(input.eventId, "ASSET_SCAN_EVENT_ID_INVALID");
    bounded(input.siteRef, "ASSET_SITE_REF_INVALID");
    bounded(input.candidateRef, "ASSET_BLOB_CANDIDATE_REF_INVALID");
    bounded(input.correlationId, "ASSET_CORRELATION_ID_INVALID");
    if (input.expectedVersion < 1n) throw new Error("ASSET_BLOB_CANDIDATE_VERSION_INVALID");
    const scope = Object.freeze({ operation: "asset.scan.evaluate" as const, siteRef: input.siteRef });
    const work = await this.dependencies.unitOfWork.execute(scope, (transaction) =>
      this.dependencies.repository.claimScanWork(transaction, input));
    if (work.disposition !== "work") return Object.freeze({ disposition: "superseded" });
    const policy = await this.dependencies.policyResolver.resolve({
      siteRef: work.candidate.siteRef,
      policyRevisionRef: work.candidate.policyRevisionRef,
      purpose: work.candidate.purpose,
    });
    const observation = await this.dependencies.scanner.inspect({
      storageTenantRef: work.candidate.storageTenantRef,
      storageRegion: work.candidate.storageRegion,
      quarantineObjectRef: work.candidate.quarantineObjectRef,
      providerVersionRef: work.candidate.providerVersionRef,
      expectedChecksumSha256: work.candidate.checksumSha256,
      maximumBytes: work.candidate.observedSize,
      policy,
    });
    const decision = evaluateAssetScan({
      evaluationRef: this.reference(), candidate: work.candidate, policy, observation,
    });
    const persisted = this.persistedDecision(input, work.candidate, decision);
    const result = await this.dependencies.unitOfWork.execute(scope, (transaction) =>
      this.dependencies.repository.recordDecision(transaction, {
        expectedCandidateVersion: work.candidate.expectedVersion,
        decision: persisted,
      }));
    if (result === "superseded") return Object.freeze({ disposition: "superseded" });
    if (persisted.disposition === "clean") {
      return Object.freeze({ disposition: "promotion_pending",
        assetVersionRef: persisted.promotion.assetVersionRef });
    }
    return Object.freeze({
      disposition: persisted.disposition === "unavailable" ? "retry" : "rejected",
      code: persisted.code,
    });
  }

  private persistedDecision(
    input: Readonly<{ eventId: string; siteRef: string; correlationId: string }>,
    candidate: Parameters<typeof createAssetPromotionIntent>[0]["candidate"],
    decision: ReturnType<typeof evaluateAssetScan>,
  ): PersistedAssetScanDecision {
    if (decision.disposition === "unavailable") {
      return Object.freeze({ disposition: decision.disposition, code: decision.code,
        evaluation: decision.evaluation });
    }
    if (decision.disposition === "rejected") {
      return Object.freeze({ disposition: decision.disposition, code: decision.code,
        evaluation: decision.evaluation,
        cleanupEvent: eventEnvelope(input, "asset.quarantine.cleanup.requested", candidate.sessionRef,
          json({ kind: "asset_quarantine_cleanup_requested_v1", siteRef: input.siteRef,
            candidateRef: candidate.candidateRef, reasonCode: decision.code }), this.reference()),
      });
    }
    const promotionRef = this.reference();
    const assetRef = this.reference();
    const assetVersionRef = this.reference();
    const blobRef = this.reference();
    const promotion = createAssetPromotionIntent({
      promotionRef, assetRef, assetVersionRef,
      blobRef, trustedObjectRef: `trusted/${blobRef}`,
      candidate, evaluation: decision.evaluation, createdAt: this.now(),
    });
    return Object.freeze({ disposition: "clean", evaluation: decision.evaluation, promotion,
      promotionEvent: eventEnvelope(input, "asset.blob.promotion.requested", promotion.promotionRef,
        json({ kind: "asset_blob_promotion_requested_v1", siteRef: input.siteRef,
          promotionRef: promotion.promotionRef, expectedVersion: promotion.expectedVersion.toString() }),
        this.reference()),
    });
  }

  private reference(): string {
    return (this.dependencies.reference ?? randomUUID)();
  }

  private now(): string {
    return (this.dependencies.clock ?? (() => new Date()))().toISOString();
  }
}

function eventEnvelope(
  input: Readonly<{ eventId: string; correlationId: string }>,
  eventType: string,
  aggregateId: string,
  payload: JsonValue,
  eventId: string,
) {
  return Object.freeze({ eventId, owner: "asset", eventType, aggregateId, payload,
    payloadDigest: digestAssetCommand(payload), correlationId: input.correlationId,
    causationId: input.eventId });
}

function json(value: Readonly<Record<string, string>>): JsonValue {
  return Object.freeze({ ...value });
}

function bounded(value: string, code: string): void {
  if (value.length < 3 || value.length > 128) throw new Error(code);
}
