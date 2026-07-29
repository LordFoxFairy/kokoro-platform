import type { OutboxEvent } from "../../../../shared/outbox-inbox/outbox.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type { BlobCandidate, QuarantineObjectObservation } from "../../domain/blob-candidate.js";
import type { AssetUploadIntent, AssetUploadSession } from "../../domain/upload-intent.js";

export interface AssetWorkerUnitOfWorkPort {
  execute<Result>(
    scope: Readonly<{
      operation: "asset.upload-completion.observe" | "asset.scan.evaluate";
      siteRef: string;
    }>,
    work: (transaction: PlatformTransaction) => Promise<Result>,
  ): Promise<Result>;
}

export type AssetCompletionWork =
  | Readonly<{ disposition: "work"; intent: AssetUploadIntent; session: AssetUploadSession }>
  | Readonly<{ disposition: "terminal" | "superseded" }>;

export interface AssetCompletionWorkerRepositoryPort {
  loadCompletionWork(
    transaction: PlatformTransaction,
    input: Readonly<{
      siteRef: string;
      intentRef: string;
      sessionRef: string;
      expectedVersion: bigint;
    }>,
  ): Promise<AssetCompletionWork>;
  commitCandidate(
    transaction: PlatformTransaction,
    input: Readonly<{
      candidate: BlobCandidate;
      expectedSessionVersion: bigint;
      scanEvent: OutboxEvent;
    }>,
  ): Promise<"committed" | "replay" | "superseded">;
  rejectCompletion(
    transaction: PlatformTransaction,
    input: Readonly<{
      siteRef: string;
      intentRef: string;
      sessionRef: string;
      expectedSessionVersion: bigint;
      reasonCode: string;
      cleanupEvent: OutboxEvent;
    }>,
  ): Promise<"rejected" | "replay" | "superseded">;
}

export interface AssetQuarantineObjectStorePort {
  observe(input: Readonly<{
    storageTenantRef: string;
    storageRegion: string;
    quarantineObjectRef: string;
  }>): Promise<QuarantineObjectObservation>;
  computeSha256(input: Readonly<{
    storageTenantRef: string;
    storageRegion: string;
    quarantineObjectRef: string;
    providerVersionRef: string;
    maximumBytes: bigint;
  }>): Promise<string>;
}
