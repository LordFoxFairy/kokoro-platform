import { randomUUID } from "node:crypto";
import type { JsonValue } from "../../../../shared/outbox-inbox/receipt.js";
import { evaluateTrustedBlobObservation } from "../../domain/promotion-intent.js";
import { digestAssetCommand } from "../asset-digest.js";
import type { AssetWorkerUnitOfWorkPort } from "../contracts/asset-completion-worker-ports.js";
import type {
  AssetPromotionWorkerRepositoryPort,
  AssetTrustedObjectStorePort,
} from "../contracts/asset-promotion-worker-ports.js";

export type ProcessAssetPromotionResult =
  | Readonly<{ disposition: "ready"; assetRef: string; assetVersionRef: string }>
  | Readonly<{ disposition: "retry" | "quarantined"; code: string }>
  | Readonly<{ disposition: "superseded" }>;

export class ProcessAssetPromotionService {
  constructor(private readonly dependencies: Readonly<{
    unitOfWork: AssetWorkerUnitOfWorkPort;
    repository: AssetPromotionWorkerRepositoryPort;
    objectStore: AssetTrustedObjectStorePort;
    reference?: () => string;
    clock?: () => Date;
  }>) {}

  async execute(input: Readonly<{
    eventId: string;
    siteRef: string;
    promotionRef: string;
    expectedVersion: bigint;
    correlationId: string;
  }>): Promise<ProcessAssetPromotionResult> {
    bounded(input.eventId, "ASSET_PROMOTION_EVENT_ID_INVALID");
    bounded(input.siteRef, "ASSET_SITE_REF_INVALID");
    bounded(input.promotionRef, "ASSET_PROMOTION_REF_INVALID");
    bounded(input.correlationId, "ASSET_CORRELATION_ID_INVALID");
    if (input.expectedVersion < 1n) throw new Error("ASSET_PROMOTION_VERSION_INVALID");
    const scope = Object.freeze({ operation: "asset.promotion.finalize" as const,
      siteRef: input.siteRef });
    const work = await this.dependencies.unitOfWork.execute(scope, (transaction) =>
      this.dependencies.repository.claimPromotionWork(transaction, input));
    if (work.disposition !== "work") return Object.freeze({ disposition: "superseded" });
    const promotion = work.promotion;
    if (promotion.state === "pending_copy") {
      await this.dependencies.objectStore.copyExact({
        storageTenantRef: promotion.storageTenantRef,
        storageRegion: promotion.storageRegion,
        sourceObjectRef: promotion.quarantineObjectRef,
        sourceProviderVersionRef: promotion.quarantineProviderVersionRef,
        targetObjectRef: promotion.trustedObjectRef,
        expectedChecksumSha256: promotion.checksumSha256,
        expectedSize: promotion.size,
        idempotencyKey: promotion.promotionRef,
      });
    }
    const observation = await this.dependencies.objectStore.observeTrusted({
      storageTenantRef: promotion.storageTenantRef,
      storageRegion: promotion.storageRegion,
      trustedObjectRef: promotion.trustedObjectRef,
    });
    const decision = evaluateTrustedBlobObservation({ promotion, observation });
    if (decision.disposition === "retry") {
      const marked = await this.dependencies.unitOfWork.execute(scope, (transaction) =>
        this.dependencies.repository.markObserving(transaction, {
          promotionRef: promotion.promotionRef,
          siteRef: promotion.siteRef,
          expectedVersion: promotion.expectedVersion,
        }));
      return marked === "superseded"
        ? Object.freeze({ disposition: "superseded" })
        : decision;
    }
    if (decision.disposition === "rejected") {
      if (observation.disposition !== "present") throw new Error("ASSET_OBSERVATION_INVARIANT");
      const cleanupGroupRef = this.reference();
      const trustedCleanupRef = this.reference();
      const trustedCleanupEvent = cleanupEventEnvelope(input, trustedCleanupRef, this.reference());
      const quarantineCleanupRef = this.reference();
      const quarantineCleanupEvent = cleanupEventEnvelope(input, quarantineCleanupRef, this.reference());
      const rejected = await this.dependencies.unitOfWork.execute(scope, (transaction) =>
        this.dependencies.repository.rejectPromotion(transaction, {
          promotionRef: promotion.promotionRef,
          siteRef: promotion.siteRef,
          expectedVersion: promotion.expectedVersion,
          reasonCode: decision.code,
          rejectionRef: this.reference(),
          cleanupPlan: Object.freeze({ cleanupGroupRef, terminalReservationState: "released",
            targets: Object.freeze([
              Object.freeze({ cleanupRef: trustedCleanupRef, objectRole: "trusted_copy" as const,
                storageTenantRef: promotion.storageTenantRef,
                storageRegion: promotion.storageRegion,
                objectRef: promotion.trustedObjectRef,
                providerVersionRef: observation.providerVersionRef,
                retainedBytes: observation.size,
                cleanupEvent: trustedCleanupEvent }),
              Object.freeze({ cleanupRef: quarantineCleanupRef, objectRole: "quarantine" as const,
                storageTenantRef: promotion.storageTenantRef,
                storageRegion: promotion.storageRegion,
                objectRef: promotion.quarantineObjectRef,
                providerVersionRef: promotion.quarantineProviderVersionRef,
                retainedBytes: promotion.size,
                cleanupEvent: quarantineCleanupEvent }),
            ]),
          }),
        }));
      return rejected === "superseded"
        ? Object.freeze({ disposition: "superseded" })
        : Object.freeze({ disposition: "quarantined", code: decision.code });
    }
    const receiptRef = this.reference();
    const referenceRef = this.reference();
    const eligibilityRef = this.reference();
    const readyEvent = eventEnvelope(input, "asset.version.ready", promotion.assetVersionRef,
      json({ kind: "asset_version_ready_v1", siteRef: promotion.siteRef,
        assetRef: promotion.assetRef, assetVersionRef: promotion.assetVersionRef,
        eligibilityRef }), this.reference());
    const cleanupGroupRef = this.reference();
    const cleanupRef = this.reference();
    const cleanupEvent = cleanupEventEnvelope(input, cleanupRef, this.reference());
    const finalized = await this.dependencies.unitOfWork.execute(scope, (transaction) =>
      this.dependencies.repository.finalizePromotion(transaction, {
        promotion,
        expectedPromotionVersion: promotion.expectedVersion,
        observation: decision.observation,
        receiptRef,
        referenceRef,
        eligibilityRef,
        cleanupPlan: Object.freeze({ cleanupGroupRef, terminalReservationState: "promoted",
          targets: Object.freeze([Object.freeze({ cleanupRef, objectRole: "quarantine" as const,
            storageTenantRef: promotion.storageTenantRef,
            storageRegion: promotion.storageRegion,
            objectRef: promotion.quarantineObjectRef,
            providerVersionRef: promotion.quarantineProviderVersionRef,
            retainedBytes: promotion.size,
            cleanupEvent,
          })]),
        }),
        readyEvent,
        completedAt: this.now(),
      }));
    return finalized === "superseded"
      ? Object.freeze({ disposition: "superseded" })
      : Object.freeze({ disposition: "ready", assetRef: promotion.assetRef,
        assetVersionRef: promotion.assetVersionRef });
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

function cleanupEventEnvelope(
  input: Readonly<{ eventId: string; correlationId: string; siteRef: string }>,
  cleanupRef: string,
  eventId: string,
) {
  return eventEnvelope(input, "asset.object.cleanup.requested", cleanupRef,
    json({ kind: "asset_object_cleanup_requested_v1", siteRef: input.siteRef,
      cleanupRef, expectedVersion: "1" }), eventId);
}

function bounded(value: string, code: string): void {
  if (value.length < 3 || value.length > 128) throw new Error(code);
}
