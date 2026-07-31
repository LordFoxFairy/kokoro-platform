import { describe, expect, it } from "vitest";
import {
  createModelImageWorkerProductionComposition,
  loadModelImageWorkerProductionAdapters,
} from
  "../../src/process/model-image-worker-composition.js";
import type { CertifiedImageEffectProvider } from
  "../../src/modules/model-gateway/application/image-effect-worker.js";
import type {
  ImageEffectPool,
  ImageEffectSecretProtector,
} from "../../src/modules/model-gateway/infrastructure/postgres/image-effect-postgres.js";

describe("model image worker production composition", () => {
  it("fails startup closed while no independently certified provider adapter is pinned", () => {
    expect(() => loadModelImageWorkerProductionAdapters())
      .toThrow("PLATFORM_MODEL_IMAGE_WORKER_CERTIFIED_PROVIDER_NOT_CONFIGURED");
  });

  it("stops new claims and returns only this owner's leases with a reason-specific code", async () => {
    const queries: Array<Readonly<{ text: string; values: readonly unknown[] }>> = [];
    const pool: ImageEffectPool = {
      connect: async () => ({
        query: async (text, values = []) => {
          queries.push(Object.freeze({ text, values }));
          return { rows: [{ returnedCount: "2" }], rowCount: 1 };
        },
        release: () => undefined,
      }),
      end: async () => undefined,
    };
    const provider: CertifiedImageEffectProvider = {
      certification: () => ({ adapterKind: "certified-image-v1",
        protocol: "kokoro.image-provider-effects.v1", idempotency: "provider-operation-key" }),
      begin: async () => { throw new Error("PROVIDER_MUST_NOT_RUN_AFTER_STOP_CLAIMING"); },
    };
    const protector: ImageEffectSecretProtector = {
      seal: () => ({ algorithm: "A256GCM", keyRevision: "response-key", nonce: "nonce",
        ciphertext: "ciphertext", authenticationTag: "tag" }),
      unseal: () => new Uint8Array(),
    };
    const composition = createModelImageWorkerProductionComposition({
      pool,
      workerId: "model-image-worker:test",
      adapters: {
        provider,
        secretProtector: protector,
        outputIdentity: () => ({ outputEvidenceRef: "output:evidence",
          outputEvidenceDigest: "a".repeat(64) }),
      },
    });

    await composition.stopClaiming();
    await composition.runOneCycle({ signal: new AbortController().signal });
    expect(queries).toEqual([]);

    await composition.returnLeases("shutdown-deadline");
    expect(queries).toEqual([{
      text: expect.stringContaining("platform.return_model_image_effect_dispatch_leases($1,$2)"),
      values: ["model-image-worker:test", "IMAGE_EFFECT_WORKER_SHUTDOWN_DEADLINE"],
    }]);
  });
});
