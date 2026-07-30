import type { PlatformTransactionalDatabaseClient } from "../infrastructure/postgres/client.js";
import { SiteRuntimeDispatcher } from "../modules/site/application/services/site-runtime-dispatcher.js";
import { PostgresSiteAuthorityRepository } from "../modules/site/infrastructure/postgres/site-authority-repository.js";
import { PostgresSiteWorkerProjectBindingLock } from
  "../modules/site/infrastructure/postgres/site-worker-project-binding-lock.js";
import {
  createPostgresSiteRuntimeEventQueue,
  SiteOutboxConsumer,
} from "../modules/site/infrastructure/postgres/site-outbox-consumer.js";
import {
  createPostgresSiteRuntimeTransactionRunner,
  PostgresSiteRuntimeStateStore,
} from "../modules/site/infrastructure/postgres/site-runtime-state-store.js";
import { loadSiteProviderRegistry } from "../modules/site/infrastructure/rpc/site-provider-registry-config.js";
import type { PlatformWorkerCycleContext } from "./worker.js";
import { createSessionAuthorizationEventSigner } from
  "../modules/authorization/infrastructure/jose/session-authorization-event-signer.js";
import { loadAuthorizationEventKeyRing } from "./platform-public-composition.js";
import { createSiteAuthorizationMutation } from "./site-admin-composition.js";

export interface SiteRuntimeWorkerProductionComposition {
  runOneCycle(context: PlatformWorkerCycleContext): Promise<void>;
  stopClaiming(): Promise<void>;
  returnLease(reason: "shutdown" | "shutdown-deadline" | "stop-claim-failed"): Promise<void>;
}

export async function createSiteRuntimeWorkerProductionComposition(input: Readonly<{
  database: PlatformTransactionalDatabaseClient;
  workerId: string;
  environment?: Readonly<Record<string, string | undefined>>;
}>): Promise<SiteRuntimeWorkerProductionComposition> {
  const environment = input.environment ?? process.env;
  const registryPath = required(environment, "PLATFORM_SITE_PROVIDER_REGISTRY_FILE");
  const workerId = scopedIdentifier(input.workerId, "PLATFORM_SITE_WORKER_ID_INVALID");
  const claimLimit = optionalBoundedInteger(environment, "PLATFORM_SITE_OUTBOX_CLAIM_LIMIT", 1, 100);
  const leaseSeconds = optionalBoundedInteger(environment, "PLATFORM_SITE_OUTBOX_LEASE_SECONDS", 1, 300) ?? 30;
  const [providers, eventKeyRing] = await Promise.all([
    loadSiteProviderRegistry(registryPath),
    loadAuthorizationEventKeyRing(required(environment, "PLATFORM_AUTHORIZATION_EVENT_KEY_RING_FILE")),
  ]);
  const eventSigner = await createSessionAuthorizationEventSigner(eventKeyRing);
  const repository = new PostgresSiteAuthorityRepository(
    new PostgresSiteWorkerProjectBindingLock(),
  );
  const store = new PostgresSiteRuntimeStateStore(
    createPostgresSiteRuntimeTransactionRunner(input.database),
    repository,
    createSiteAuthorizationMutation(eventSigner),
  );
  const dispatcher = new SiteRuntimeDispatcher(store, providers);
  const queue = createPostgresSiteRuntimeEventQueue(input.database, {
    workerId,
    ...(claimLimit === undefined ? {} : { claimLimit }),
    leaseSeconds,
  });
  const consumer = new SiteOutboxConsumer(queue, dispatcher, {
    leaseHeartbeatMs: Math.max(1, Math.floor((leaseSeconds * 1_000) / 3)),
  });
  const composition: SiteRuntimeWorkerProductionComposition = {
    runOneCycle: (context) => consumer.runOneCycle(context),
    stopClaiming: () => consumer.stopClaiming(),
    returnLease: (reason) => consumer.returnLeases(reason),
  };
  return Object.freeze(composition);
}

function scopedIdentifier(value: string, code: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(value)) throw new Error(code);
  return value;
}

function required(environment: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) throw new Error(`${name}_REQUIRED`);
  return value;
}
function optionalBoundedInteger(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = environment[name];
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`${name}_INVALID`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name}_INVALID`);
  }
  return parsed;
}
