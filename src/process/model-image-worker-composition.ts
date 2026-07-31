import { ImageEffectDispatchWorker, type CertifiedImageEffectProvider } from
  "../modules/model-gateway/application/image-effect-worker.js";
import type { ImageEffectOutputEvidenceIdentityAuthority } from
  "../modules/model-gateway/domain/image-effect-evidence.js";
import {
  PostgresImageEffectDispatchSecretLoader,
  PostgresImageEffectWorkerRepository,
  type ImageEffectPool,
  type ImageEffectSecretProtector,
} from "../modules/model-gateway/infrastructure/postgres/image-effect-postgres.js";
import type { PlatformWorkerCycleContext } from "./worker.js";

export interface ModelImageWorkerProductionAdapters {
  readonly provider: CertifiedImageEffectProvider;
  readonly secretProtector: ImageEffectSecretProtector;
  readonly outputIdentity: ImageEffectOutputEvidenceIdentityAuthority;
}

export interface ModelImageWorkerProductionComposition {
  runOneCycle(context: PlatformWorkerCycleContext): Promise<void>;
  stopClaiming(): Promise<void>;
  returnLeases(reason: "shutdown" | "shutdown-deadline" | "stop-claim-failed"): Promise<void>;
}

export function createModelImageWorkerProductionComposition(input: Readonly<{
  pool: ImageEffectPool;
  workerId: string;
  leaseMilliseconds?: number;
  adapters: ModelImageWorkerProductionAdapters;
}>): ModelImageWorkerProductionComposition {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(input.workerId)) {
    throw new Error("PLATFORM_MODEL_IMAGE_WORKER_ID_INVALID");
  }
  const leaseMilliseconds = input.leaseMilliseconds ?? 30_000;
  const repository = new PostgresImageEffectWorkerRepository({ pool: input.pool,
    secretProtector: input.adapters.secretProtector, outputIdentity: input.adapters.outputIdentity });
  const worker = new ImageEffectDispatchWorker({ repository,
    secrets: new PostgresImageEffectDispatchSecretLoader({ pool: input.pool,
      secretProtector: input.adapters.secretProtector }),
    provider: input.adapters.provider, dispatchOwnerRef: input.workerId, leaseMilliseconds });
  let claiming = true;
  const composition: ModelImageWorkerProductionComposition = {
    runOneCycle: async ({ signal }) => { if (claiming) await worker.runOne(signal); },
    stopClaiming: async () => { claiming = false; },
    returnLeases: async () => undefined,
  };
  return Object.freeze(composition);
}

/** Production stays closed until a certified provider package is independently released and pinned. */
export function loadModelImageWorkerProductionAdapters(): never {
  throw new Error("PLATFORM_MODEL_IMAGE_WORKER_CERTIFIED_PROVIDER_NOT_CONFIGURED");
}
