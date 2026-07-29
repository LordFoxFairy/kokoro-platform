import { randomUUID } from "node:crypto";
import type { AssetWorkerUnitOfWorkPort } from
  "../contracts/asset-completion-worker-ports.js";
import type {
  AssetObjectCleanupRepositoryPort,
  AssetObjectCleanupStorePort,
} from "../contracts/asset-cleanup-worker-ports.js";

export type ProcessAssetObjectCleanupResult =
  | Readonly<{ disposition: "completed" }>
  | Readonly<{ disposition: "retry"; code: string }>
  | Readonly<{ disposition: "superseded" }>;

export class ProcessAssetObjectCleanupService {
  constructor(private readonly dependencies: Readonly<{
    unitOfWork: AssetWorkerUnitOfWorkPort;
    repository: AssetObjectCleanupRepositoryPort;
    objectStore: AssetObjectCleanupStorePort;
    reference?: () => string;
  }>) {}

  async execute(input: Readonly<{
    eventId: string;
    siteRef: string;
    cleanupRef: string;
    expectedVersion: bigint;
    correlationId: string;
  }>): Promise<ProcessAssetObjectCleanupResult> {
    bounded(input.eventId, "ASSET_CLEANUP_EVENT_ID_INVALID");
    bounded(input.siteRef, "ASSET_SITE_REF_INVALID");
    bounded(input.cleanupRef, "ASSET_CLEANUP_REF_INVALID");
    bounded(input.correlationId, "ASSET_CORRELATION_ID_INVALID");
    if (input.expectedVersion < 1n) throw new Error("ASSET_CLEANUP_VERSION_INVALID");
    const scope = Object.freeze({ operation: "asset.cleanup.delete" as const,
      siteRef: input.siteRef });
    const work = await this.dependencies.unitOfWork.execute(scope, (transaction) =>
      this.dependencies.repository.claimCleanupWork(transaction, input));
    if (work.disposition !== "work") return Object.freeze({ disposition: "superseded" });
    let deletion;
    try {
      deletion = await this.dependencies.objectStore.deleteExact({
        storageTenantRef: work.cleanup.storageTenantRef,
        storageRegion: work.cleanup.storageRegion,
        objectRef: work.cleanup.objectRef,
        providerVersionRef: work.cleanup.providerVersionRef,
        expectedSize: work.cleanup.retainedBytes,
      });
    } catch {
      deletion = Object.freeze({ disposition: "retry" as const,
        code: "ASSET_OBJECT_DELETE_OUTCOME_UNKNOWN" as const });
    }
    if (deletion.disposition === "retry") {
      const recorded = await this.dependencies.unitOfWork.execute(scope, (transaction) =>
        this.dependencies.repository.markCleanupRetry(transaction, {
          siteRef: work.cleanup.siteRef,
          cleanupRef: work.cleanup.cleanupRef,
          expectedVersion: work.cleanup.expectedVersion,
          reasonCode: deletion.code,
        }));
      return recorded === "superseded"
        ? Object.freeze({ disposition: "superseded" })
        : deletion;
    }
    const completed = await this.dependencies.unitOfWork.execute(scope, (transaction) =>
      this.dependencies.repository.completeCleanup(transaction, {
        cleanup: work.cleanup,
        expectedCleanupVersion: work.cleanup.expectedVersion,
        receiptRef: (this.dependencies.reference ?? randomUUID)(),
        deletion,
      }));
    return completed === "superseded"
      ? Object.freeze({ disposition: "superseded" })
      : Object.freeze({ disposition: "completed" });
  }
}

function bounded(value: string, code: string): void {
  if (value.length < 3 || value.length > 128) throw new Error(code);
}
