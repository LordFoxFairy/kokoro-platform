import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createIdentityOutboxWorkerProductionComposition } from
  "../../src/process/identity-outbox-worker-composition.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Identity outbox worker production composition", () => {
  it("fails fast when the delivery endpoint or HMAC secret is absent", async () => {
    await expect(createIdentityOutboxWorkerProductionComposition({
      database: database(),
      workerId: "identity-worker-01",
      environment: {},
    })).rejects.toThrow("PLATFORM_IDENTITY_AUDIT_DIGEST_KEY_FILE_REQUIRED");

    const fixtures = await secretFixtures();
    await expect(createIdentityOutboxWorkerProductionComposition({
      database: database(),
      workerId: "identity-worker-01",
      environment: {
        PLATFORM_IDENTITY_AUDIT_DIGEST_KEY_FILE: fixtures.auditKey,
        PLATFORM_IDENTITY_DELIVERY_HMAC_KEY_ID: "identity-delivery-key-1",
        PLATFORM_IDENTITY_DELIVERY_HMAC_SECRET_FILE: fixtures.hmacSecret,
        PLATFORM_IDENTITY_SECRET_TRUST_ROOT: fixtures.directory,
      },
    })).rejects.toThrow("PLATFORM_IDENTITY_DELIVERY_ENDPOINT_REQUIRED");
  });

  it("builds a provider-neutral HMAC/HTTPS consumer without connecting or logging secrets", async () => {
    const fixtures = await secretFixtures();
    const runtime = await createIdentityOutboxWorkerProductionComposition({
      database: database(),
      workerId: "identity-worker-01",
      environment: {
        PLATFORM_IDENTITY_AUDIT_DIGEST_KEY_FILE: fixtures.auditKey,
        PLATFORM_IDENTITY_DELIVERY_ENDPOINT: "https://delivery.internal/v1/identity",
        PLATFORM_IDENTITY_DELIVERY_HMAC_KEY_ID: "identity-delivery-key-1",
        PLATFORM_IDENTITY_DELIVERY_HMAC_SECRET_FILE: fixtures.hmacSecret,
        PLATFORM_IDENTITY_SECRET_TRUST_ROOT: fixtures.directory,
        PLATFORM_IDENTITY_DELIVERY_TIMEOUT_MS: "5000",
      },
    });

    expect(runtime).toEqual({
      runOneCycle: expect.any(Function),
      stopClaiming: expect.any(Function),
      returnLeases: expect.any(Function),
    });
  });
});

async function secretFixtures() {
  const directory = await mkdtemp(join(tmpdir(), "kokoro-identity-worker-"));
  cleanup.push(directory);
  const auditKey = join(directory, "audit.key");
  const hmacSecret = join(directory, "delivery-hmac.key");
  await writeFile(auditKey, `${Buffer.alloc(32, 3).toString("base64url")}\n`, { mode: 0o600 });
  await writeFile(hmacSecret, `${Buffer.alloc(32, 7).toString("base64")}\n`, { mode: 0o600 });
  await chmod(auditKey, 0o600);
  await chmod(hmacSecret, 0o600);
  return { auditKey, hmacSecret, directory };
}

function database() {
  return {
    internalTransaction: async () => {
      throw new Error("not used");
    },
  };
}
