import type { PlatformTransactionalDatabaseClient } from
  "../infrastructure/postgres/client.js";
import { IdentityOutboxConsumer } from
  "../modules/identity/application/services/identity-outbox-consumer.js";
import { createIdentityAuditDigester } from
  "../modules/identity/infrastructure/crypto/identity-audit-digester.js";
import { HmacIdentityVerificationDeliveryAdapter } from
  "../modules/identity/infrastructure/http/hmac-identity-verification-delivery.js";
import { createPostgresIdentityEffectEventQueue } from
  "../modules/identity/infrastructure/postgres/identity-outbox-consumer.js";
import { readBoundedPrivateFileWithinTrustRoot } from "./secret-files.js";

export interface IdentityOutboxWorkerProductionComposition {
  runOneCycle(context: Readonly<{ signal: AbortSignal }>): Promise<void>;
  stopClaiming(): Promise<void>;
  returnLeases(
    reason: "shutdown" | "shutdown-deadline" | "stop-claim-failed",
  ): Promise<void>;
}

export async function createIdentityOutboxWorkerProductionComposition(input: Readonly<{
  database: Pick<PlatformTransactionalDatabaseClient, "internalTransaction">;
  workerId: string;
  environment?: Readonly<Record<string, string | undefined>>;
}>): Promise<IdentityOutboxWorkerProductionComposition> {
  const environment = input.environment ?? process.env;
  const auditKeyPath = required(environment, "PLATFORM_IDENTITY_AUDIT_DIGEST_KEY_FILE");
  const endpoint = required(environment, "PLATFORM_IDENTITY_DELIVERY_ENDPOINT");
  const keyId = required(environment, "PLATFORM_IDENTITY_DELIVERY_HMAC_KEY_ID");
  const hmacSecretPath = required(environment, "PLATFORM_IDENTITY_DELIVERY_HMAC_SECRET_FILE");
  const secretTrustRoot = required(environment, "PLATFORM_IDENTITY_SECRET_TRUST_ROOT");
  const [auditKeyValue, hmacSecretBase64] = await Promise.all([
    readBoundedPrivateFileWithinTrustRoot(
      auditKeyPath,
      secretTrustRoot,
      256,
      "IDENTITY_AUDIT_KEY_FILE_INVALID",
    ),
    readBoundedPrivateFileWithinTrustRoot(
      hmacSecretPath,
      secretTrustRoot,
      512,
      "IDENTITY_DELIVERY_HMAC_SECRET_FILE_INVALID",
    ),
  ]);
  const auditKey = base64UrlSecret(auditKeyValue.trim(), 32, "IDENTITY_AUDIT_KEY_FILE_INVALID");
  const delivery = new HmacIdentityVerificationDeliveryAdapter({
    endpoint,
    keyId,
    secretBase64: hmacSecretBase64.trim(),
    timeoutMs: boundedInteger(
      environment.PLATFORM_IDENTITY_DELIVERY_TIMEOUT_MS ?? "10000",
      100,
      60_000,
      "PLATFORM_IDENTITY_DELIVERY_TIMEOUT_MS_INVALID",
    ),
  });
  const consumer = new IdentityOutboxConsumer(
    createPostgresIdentityEffectEventQueue(input.database, { workerId: input.workerId }),
    delivery,
    { auditDigest: createIdentityAuditDigester(auditKey) },
  );
  const runtime: IdentityOutboxWorkerProductionComposition = {
    runOneCycle: (context) => consumer.runOneCycle(context),
    stopClaiming: () => consumer.stopClaiming(),
    returnLeases: (reason) => consumer.returnLeases(reason),
  };
  return Object.freeze(runtime);
}

function required(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) throw new Error(`${name}_REQUIRED`);
  return value;
}

function base64UrlSecret(value: string, length: number, code: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error(code);
  const bytes = Buffer.from(value, "base64url");
  if (bytes.byteLength !== length || bytes.toString("base64url") !== value) throw new Error(code);
  return bytes;
}

function boundedInteger(value: string, minimum: number, maximum: number, code: string): number {
  if (!/^[0-9]+$/u.test(value)) throw new Error(code);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(code);
  return parsed;
}
