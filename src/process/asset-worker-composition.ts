import type { PlatformTransactionalDatabaseClient } from
  "../infrastructure/postgres/client.js";
import type { AssetObjectCleanupStorePort } from
  "../modules/asset/application/contracts/asset-cleanup-worker-ports.js";
import type {
  AssetQuarantineObjectStorePort,
  AssetWorkerUnitOfWorkPort,
} from "../modules/asset/application/contracts/asset-completion-worker-ports.js";
import type { AssetTrustedObjectStorePort } from
  "../modules/asset/application/contracts/asset-promotion-worker-ports.js";
import type {
  AssetInspectionPolicyResolverPort,
  AssetSecurityScannerPort,
} from "../modules/asset/application/contracts/asset-scan-worker-ports.js";
import { ProcessAssetObjectCleanupService } from
  "../modules/asset/application/services/process-asset-object-cleanup.js";
import { ProcessAssetPromotionService } from
  "../modules/asset/application/services/process-asset-promotion.js";
import { ProcessAssetScanService } from
  "../modules/asset/application/services/process-asset-scan.js";
import { ProcessUploadCompletionService } from
  "../modules/asset/application/services/process-upload-completion.js";
import { PostgresAssetObjectCleanupRepository } from
  "../modules/asset/infrastructure/postgres/asset-cleanup-repository.js";
import {
  AssetOutboxConsumer,
  createPostgresAssetEffectEventQueue,
} from "../modules/asset/infrastructure/postgres/asset-outbox-consumer.js";
import { PostgresAssetPromotionRepository } from
  "../modules/asset/infrastructure/postgres/asset-promotion-repository.js";
import { PostgresAssetScanRepository } from
  "../modules/asset/infrastructure/postgres/asset-scan-repository.js";
import { PostgresAssetUploadRepository } from
  "../modules/asset/infrastructure/postgres/asset-upload-repository.js";
import type { PlatformWorkerCycleContext } from "./worker.js";
import type { PlatformTransaction } from "../shared/unit-of-work/platform-transaction.js";

type AssetObjectStore = AssetQuarantineObjectStorePort & AssetTrustedObjectStorePort &
  AssetObjectCleanupStorePort;

export interface AssetWorkerProductionAdapters {
  readonly scanner?: AssetSecurityScannerPort;
  readonly policyResolver?: AssetInspectionPolicyResolverPort;
  readonly objectStore?: AssetObjectStore;
}

export interface AssetWorkerProductionComposition {
  readonly enabled: boolean;
  runOneCycle(context: PlatformWorkerCycleContext): Promise<void>;
  stopClaiming(): Promise<void>;
  returnLeases(reason: "shutdown" | "shutdown-deadline" | "stop-claim-failed"): Promise<void>;
}

export async function createAssetWorkerProductionComposition(input: Readonly<{
  database: PlatformTransactionalDatabaseClient;
  workerId: string;
  environment?: Readonly<Record<string, string | undefined>>;
  adapters?: AssetWorkerProductionAdapters;
}>): Promise<AssetWorkerProductionComposition> {
  const environment = input.environment ?? process.env;
  const enabled = optionalBoolean(environment, "PLATFORM_ASSET_WORKER_ENABLED") ?? false;
  if (!enabled) return DISABLED_ASSET_WORKER;

  // Asset inspection is a security boundary. There is deliberately no permissive,
  // in-process or test-double fallback in the production composition.
  const scanner = input.adapters?.scanner;
  if (scanner === undefined) throw new Error("PLATFORM_ASSET_SCANNER_ADAPTER_REQUIRED");
  const policyResolver = input.adapters?.policyResolver;
  if (policyResolver === undefined) {
    throw new Error("PLATFORM_ASSET_INSPECTION_POLICY_ADAPTER_REQUIRED");
  }
  const objectStore = input.adapters?.objectStore;
  if (objectStore === undefined) throw new Error("PLATFORM_ASSET_OBJECT_STORE_ADAPTER_REQUIRED");

  const executionEnvironment = required(environment, "PLATFORM_ENVIRONMENT");
  const region = required(environment, "PLATFORM_REGION");
  scopedIdentifier(input.workerId, "PLATFORM_ASSET_WORKER_ID_INVALID");
  const unitOfWork = createAssetWorkerUnitOfWork(input.database, {
    environment: executionEnvironment,
    region,
  });
  const services = {
    completion: new ProcessUploadCompletionService({
      unitOfWork,
      repository: new PostgresAssetUploadRepository(),
      objectStore,
    }),
    scan: new ProcessAssetScanService({
      unitOfWork,
      repository: new PostgresAssetScanRepository(),
      policyResolver,
      scanner,
    }),
    promotion: new ProcessAssetPromotionService({
      unitOfWork,
      repository: new PostgresAssetPromotionRepository(),
      objectStore,
    }),
    cleanup: new ProcessAssetObjectCleanupService({
      unitOfWork,
      repository: new PostgresAssetObjectCleanupRepository(),
      objectStore,
    }),
  };
  const claimLimit = optionalInteger(environment, "PLATFORM_ASSET_OUTBOX_CLAIM_LIMIT");
  const leaseSeconds = optionalInteger(environment, "PLATFORM_ASSET_OUTBOX_LEASE_SECONDS");
  const effectiveLeaseSeconds = leaseSeconds ?? 30;
  const consumer = new AssetOutboxConsumer(
    createPostgresAssetEffectEventQueue(input.database, {
      workerId: input.workerId,
      ...(claimLimit === undefined ? {} : { claimLimit }),
      ...(leaseSeconds === undefined ? {} : { leaseSeconds }),
    }),
    services,
    { leaseHeartbeatMs: Math.max(100, Math.floor(effectiveLeaseSeconds * 1_000 / 3)) },
  );
  const composition: AssetWorkerProductionComposition = {
    enabled: true,
    runOneCycle: (context) => consumer.runOneCycle(context),
    stopClaiming: () => consumer.stopClaiming(),
    returnLeases: (reason) => consumer.returnLeases(reason),
  };
  return Object.freeze(composition);
}

export function createAssetWorkerUnitOfWork(
  database: Pick<PlatformTransactionalDatabaseClient, "internalScopedTransaction">,
  scope: Readonly<{ environment: string; region: string }>,
): AssetWorkerUnitOfWorkPort {
  const environment = scopedIdentifier(scope.environment, "PLATFORM_INTERNAL_ENVIRONMENT_INVALID");
  const region = scopedIdentifier(scope.region, "PLATFORM_INTERNAL_REGION_INVALID");
  const unitOfWork: AssetWorkerUnitOfWorkPort = {
    execute<Result>(
      operationScope: Readonly<{
        operation: "asset.upload-completion.observe" | "asset.scan.evaluate" |
          "asset.promotion.finalize" | "asset.cleanup.delete";
        siteRef: string;
      }>,
      work: (transaction: PlatformTransaction) => Promise<Result>,
    ): Promise<Result> {
      return database.internalScopedTransaction({
        ...operationScope,
        environment,
        region,
        scopes: ["asset:worker"],
      }, work);
    },
  };
  return Object.freeze(unitOfWork);
}

const DISABLED_ASSET_WORKER: AssetWorkerProductionComposition = Object.freeze({
  enabled: false,
  runOneCycle: async () => undefined,
  stopClaiming: async () => undefined,
  returnLeases: async () => undefined,
});

function required(environment: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) throw new Error(`${name}_REQUIRED`);
  return value;
}

function optionalBoolean(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): boolean | undefined {
  const value = environment[name];
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name}_INVALID`);
}

function optionalInteger(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): number | undefined {
  const value = environment[name];
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`${name}_INVALID`);
  return Number(value);
}

function scopedIdentifier(value: string, code: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(value)) throw new Error(code);
  return value;
}
