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
import {
  PostgresAssetWorkerAuthorityLock,
  type AssetWorkerAuthorityLock,
} from
  "../modules/asset/infrastructure/postgres/asset-worker-authority-lock.js";
import { parseAssetInspectionPolicyRegistry } from
  "../modules/asset/infrastructure/config/asset-inspection-policy-registry.js";
import { HttpsAssetSecurityScanner } from
  "../modules/asset/infrastructure/http/asset-security-scanner.js";
import { S3AssetObjectStore } from
  "../modules/asset/infrastructure/s3/asset-object-store.js";
import { parseAssetStorageRouteRegistry } from "./asset-data-plane-composition.js";
import { createBoundedFileReaderWithinTrustRoot } from "./secret-files.js";
import type { PlatformWorkerCycleContext } from "./worker.js";
import type { PlatformTransaction } from "../shared/unit-of-work/platform-transaction.js";

type AssetObjectStore = AssetQuarantineObjectStorePort & AssetTrustedObjectStorePort &
  AssetObjectCleanupStorePort;

export interface AssetWorkerProductionAdapters {
  readonly scanner: AssetSecurityScannerPort;
  readonly policyResolver: AssetInspectionPolicyResolverPort;
  readonly objectStore: AssetObjectStore;
}

export interface AssetWorkerProductionComposition {
  runOneCycle(context: PlatformWorkerCycleContext): Promise<void>;
  stopClaiming(): Promise<void>;
  returnLeases(reason: "shutdown" | "shutdown-deadline" | "stop-claim-failed"): Promise<void>;
}

export function createAssetWorkerCompletionService(input: Readonly<{
  unitOfWork: AssetWorkerUnitOfWorkPort;
  objectStore: AssetQuarantineObjectStorePort;
  deployment: Readonly<{ environment: string; region: string }>;
  authorityLock?: AssetWorkerAuthorityLock;
}>): ProcessUploadCompletionService {
  return new ProcessUploadCompletionService({
    deployment: input.deployment,
    unitOfWork: input.unitOfWork,
    repository: new PostgresAssetUploadRepository(
      input.authorityLock ?? new PostgresAssetWorkerAuthorityLock(),
    ),
    objectStore: input.objectStore,
  });
}

export async function createAssetWorkerProductionComposition(input: Readonly<{
  database: PlatformTransactionalDatabaseClient;
  workerId: string;
  environment: Readonly<Record<string, string | undefined>>;
  adapters: AssetWorkerProductionAdapters;
}>): Promise<AssetWorkerProductionComposition> {
  const environment = input.environment;
  const { scanner, policyResolver, objectStore } = input.adapters;

  const executionEnvironment = required(environment, "PLATFORM_ENVIRONMENT");
  const region = required(environment, "PLATFORM_REGION");
  scopedIdentifier(input.workerId, "PLATFORM_ASSET_WORKER_ID_INVALID");
  const unitOfWork = createAssetWorkerUnitOfWork(input.database, {
    environment: executionEnvironment,
    region,
  });
  const authorityLock = new PostgresAssetWorkerAuthorityLock();
  const services = {
    completion: createAssetWorkerCompletionService({
      unitOfWork,
      objectStore,
      deployment: { environment: executionEnvironment, region },
      authorityLock,
    }),
    scan: new ProcessAssetScanService({
      deployment: { environment: executionEnvironment, region },
      unitOfWork,
      repository: new PostgresAssetScanRepository(),
      policyResolver,
      scanner,
    }),
    promotion: new ProcessAssetPromotionService({
      deployment: { environment: executionEnvironment, region },
      unitOfWork,
      repository: new PostgresAssetPromotionRepository(authorityLock),
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
      environment: executionEnvironment,
      region,
      ...(claimLimit === undefined ? {} : { claimLimit }),
      ...(leaseSeconds === undefined ? {} : { leaseSeconds }),
    }),
    services,
    { leaseHeartbeatMs: Math.max(100, Math.floor(effectiveLeaseSeconds * 1_000 / 3)) },
  );
  const composition: AssetWorkerProductionComposition = {
    runOneCycle: (context) => consumer.runOneCycle(context),
    stopClaiming: () => consumer.stopClaiming(),
    returnLeases: (reason) => consumer.returnLeases(reason),
  };
  return Object.freeze(composition);
}

export async function loadAssetWorkerProductionAdapters(
  environment: Readonly<Record<string, string | undefined>>,
): Promise<AssetWorkerProductionAdapters> {
  const reader = await createBoundedFileReaderWithinTrustRoot(
    required(environment, "PLATFORM_ASSET_WORKER_SECRET_TRUST_ROOT"),
    "PLATFORM_ASSET_WORKER_SECRET_TRUST_ROOT_INVALID",
  );
  const [routesText, policiesText, token, ca, cert, key] = await Promise.all([
    reader.readPrivate(required(environment, "PLATFORM_ASSET_STORAGE_ROUTE_FILE"), 512 * 1024,
      "PLATFORM_ASSET_STORAGE_ROUTE_FILE_INVALID"),
    reader.readRegular(required(environment, "PLATFORM_ASSET_INSPECTION_POLICY_REGISTRY_FILE"), 2 * 1024 * 1024,
      "PLATFORM_ASSET_INSPECTION_POLICY_REGISTRY_FILE_INVALID"),
    reader.readPrivate(required(environment, "PLATFORM_ASSET_SCANNER_TOKEN_FILE"), 4_096,
      "PLATFORM_ASSET_SCANNER_TOKEN_FILE_INVALID"),
    reader.readRegular(required(environment, "PLATFORM_ASSET_SCANNER_TLS_CA_FILE"), 256 * 1024,
      "PLATFORM_ASSET_SCANNER_TLS_CA_FILE_INVALID"),
    reader.readRegular(required(environment, "PLATFORM_ASSET_SCANNER_TLS_CERT_FILE"), 256 * 1024,
      "PLATFORM_ASSET_SCANNER_TLS_CERT_FILE_INVALID"),
    reader.readPrivate(required(environment, "PLATFORM_ASSET_SCANNER_TLS_KEY_FILE"), 64 * 1024,
      "PLATFORM_ASSET_SCANNER_TLS_KEY_FILE_INVALID"),
  ]);
  let routesValue: unknown;
  let policiesValue: unknown;
  try {
    routesValue = JSON.parse(routesText) as unknown;
    policiesValue = JSON.parse(policiesText) as unknown;
  } catch (error) {
    throw new Error("PLATFORM_ASSET_WORKER_REGISTRY_JSON_INVALID", { cause: error });
  }
  return Object.freeze({
    objectStore: new S3AssetObjectStore(parseAssetStorageRouteRegistry(routesValue)),
    policyResolver: parseAssetInspectionPolicyRegistry(policiesValue),
    scanner: new HttpsAssetSecurityScanner({
      endpoint: required(environment, "PLATFORM_ASSET_SCANNER_ENDPOINT"),
      audience: required(environment, "PLATFORM_ASSET_SCANNER_AUDIENCE"),
      bearerToken: token,
      timeoutMs: boundedEnvironmentInteger(environment.PLATFORM_ASSET_SCANNER_TIMEOUT_MS ?? "10000",
        100, 60_000, "PLATFORM_ASSET_SCANNER_TIMEOUT_MS_INVALID"),
      tls: { ca, cert, key },
    }),
  });
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

function required(environment: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) throw new Error(`${name}_REQUIRED`);
  return value;
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

function boundedEnvironmentInteger(
  value: string,
  minimum: number,
  maximum: number,
  code: string,
): number {
  if (!/^[0-9]+$/u.test(value)) throw new Error(code);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(code);
  return parsed;
}

function scopedIdentifier(value: string, code: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(value)) throw new Error(code);
  return value;
}
