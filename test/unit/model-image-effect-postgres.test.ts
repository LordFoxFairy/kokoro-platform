import { describe, expect, it } from "vitest";
import {
  PostgresImageEffectAuthority,
  PostgresImageEffectDispatchSecretLoader,
  PostgresImageEffectRepository,
} from "../../src/modules/model-gateway/infrastructure/postgres/image-effect-postgres.js";
import { issuePlatformTransaction, resolvePlatformTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";

const ACCESS = "h".repeat(32);
const MODEL = "m".repeat(32);

describe("Postgres image-effect authority", () => {
  it("resolves opaque access and exact model authorization before setting a Site transaction", async () => {
    const client = new Client();
    const authority = new PostgresImageEffectAuthority({ pool: {
      connect: async () => client,
      end: async () => undefined,
    } });
    const value = await authority.execute({
      operation: "create",
      callerAccessHandle: ACCESS,
      modelOptionAuthorizationHandle: MODEL,
      sourceGrants: [],
    }, async (transaction, authorization) => {
      expect(authorization).toMatchObject({
        siteId: "site:one",
        callerIdentity: "platform-media-worker:one",
        callerAudience: "platform-media-worker",
        authorizationGeneration: 7n,
        securityEpoch: 11n,
        modelOption: { modelOptionRevisionRef: "image-option:one", deploymentRef: "deployment:one" },
      });
      await resolvePlatformTransaction(transaction).execute("UPDATE exact_image_table SET state=state");
      return "ok";
    });
    expect(value).toBe("ok");
    expect(client.calls.map((call) => call.text)).toEqual([
      "BEGIN ISOLATION LEVEL READ COMMITTED",
      expect.stringContaining("resolve_model_image_effect_access"),
      expect.stringContaining("resolve_model_image_source_grant_authorizations"),
      expect.stringContaining("resolve_model_image_option_authorization"),
      expect.stringContaining("set_config('app.site_id'"),
      "UPDATE exact_image_table SET state=state",
      "COMMIT",
    ]);
    expect(client.released).toBe(true);
  });

  it("consumes the local signed budget fence with an exact canonical slot digest", async () => {
    const transaction = transactionHarness((text) => text.includes("consume_model_image_effect_budget_commit")
      ? [{ effectBudgetCommitRef: "budget:one", effectBudgetCommitDigest: "a".repeat(64),
          attemptOrdinal: 1, expiresAt: "2030-01-01T00:00:00.000Z", replayed: false }]
      : []);
    const authority = new PostgresImageEffectAuthority({ pool: { connect: async () => { throw new Error("unused"); },
      end: async () => undefined } });
    const outcome = await authority.consume(transaction.transaction, {
      siteId: "site:one", callerIdentity: "platform-media-worker:one",
      logicalInvocationRef: "invocation:one", modelInvocationCommandRef: "command:one",
      attemptRef: "attempt:one", attemptOrdinal: 1,
      effectBudgetCommitRef: "budget:one", effectBudgetCommitDigest: "a".repeat(64),
      modelOptionRevisionRef: "image-option:one", deploymentRef: "deployment:one",
      operationInputRevisionRef: "input:one", operationInputRevisionDigest: "b".repeat(64),
      logicalOutputSlots: [{ candidateRef: "candidate:one", stableOutputSlotRef: "slot:one" }],
      ownerCommandDigest: "c".repeat(64),
    });
    expect(outcome.kind).toBe("accepted");
    expect(transaction.calls[0]?.text).toContain("consume_model_image_effect_budget_commit");
    expect(transaction.calls[0]?.values[10]).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("persists invocation, attempt, queue, journal and outbox in one owner transaction", async () => {
    const transaction = transactionHarness(() => []);
    const repository = new PostgresImageEffectRepository({
      reference: () => "event:one",
      secretProtector: {
        seal: () => Object.freeze({ algorithm: "A256GCM", keyRevision: "test", nonce: "nonce",
          ciphertext: "ciphertext", authenticationTag: "tag" }),
        unseal: () => new TextEncoder().encode("[]"),
      },
    });
    await repository.create(transaction.transaction, {
      journal: {
        siteId: "site:one", callerIdentity: "platform-media-worker:one",
        callerAccessHandleDigest: "a".repeat(64), callerCommandRef: "command:one",
        commandKind: "create", ownerCommandDigest: "b".repeat(64), callerRequestFingerprint: "c".repeat(64),
        receipt: { callerCommandRef: "command:one", requestDigest: "b".repeat(64), kind: "create_committed",
          logicalInvocationRef: "invocation:one", attemptRef: "attempt:one", attemptOrdinal: 1,
          receiptVersion: 1n, recordedAt: "2026-07-31T12:00:00.000Z",
          receiptRef: `image-effect-receipt:sha256:${"d".repeat(64)}`, receiptDigest: "d".repeat(64) },
      },
      invocation: {
        siteId: "site:one", callerIdentity: "platform-media-worker:one",
        callerAccessHandleDigest: "a".repeat(64), modelOptionAuthorizationHandleDigest: "d".repeat(64),
        logicalInvocationRef: "invocation:one", modelInvocationCommandRef: "command:one", ownerVersion: 1n,
        state: "accepted", definitionRoleRef: "image.text_to_image.v1",
        modelOptionRevisionRef: "image-option:one", deploymentRef: "deployment:one",
        adapterKind: "certified-image-v1", providerModel: "provider-model:one",
        modelAuthorizationExpiresAt: "2030-01-01T00:00:00.000Z",
        operationInputRevisionRef: "input:one", operationInputRevisionDigest: "e".repeat(64),
        sourceGrantRefs: [], logicalOutputSlots: [{ candidateRef: "candidate:one", stableOutputSlotRef: "slot:one" }],
        trustEffectAllowReceiptRef: "trust:one", trustEffectAllowReceiptDigest: "f".repeat(64),
        attempts: [{ attemptRef: "attempt:one", ordinal: 1, budgetCommitRef: "budget:one",
          budgetCommitDigest: "a".repeat(64), providerOperationKey: "provider-operation:one", state: "planned",
          cancelRequested: false, lastProviderSequence: 0n, outputs: [], lateOutcome: false, observations: [] }],
        createdAt: "2026-07-31T12:00:00.000Z", updatedAt: "2026-07-31T12:00:00.000Z",
      },
      sourceGrants: [],
    });
    expect(transaction.calls.map((call) => call.text)).toEqual([
      expect.stringContaining("INSERT INTO platform.model_image_effect_invocation"),
      expect.stringContaining("INSERT INTO platform.model_image_effect_attempt"),
      expect.stringContaining("INSERT INTO platform.model_image_effect_dispatch_queue"),
      expect.stringContaining("INSERT INTO platform.model_image_effect_command_journal"),
      expect.stringContaining("INSERT INTO platform.model_image_effect_outbox"),
    ]);
  });

  it("loads source bearer only for the exact worker fence and zeroizes plaintext after use", async () => {
    const plaintext = sourceGrantEnvelope("source:one", "s".repeat(32));
    const client = new SecretClient();
    const loader = new PostgresImageEffectDispatchSecretLoader({
      pool: { connect: async () => client, end: async () => undefined },
      secretProtector: {
        seal: () => { throw new Error("unused"); },
        unseal: () => plaintext,
      },
    });
    const value = await loader.withSourceGrants({
      attemptRef: "attempt:one",
      dispatchOwnerRef: "worker:one",
      dispatchFence: 7n,
    }, async (grants) => {
      expect(grants[0]?.sourceVersionRef).toBe("source:one");
      return new TextDecoder().decode(grants[0]?.purposeGrantHandle);
    });
    expect(value).toBe("s".repeat(32));
    expect(plaintext.every((byte) => byte === 0)).toBe(true);
    expect(client.calls[0]?.text).toContain("load_model_image_effect_dispatch_secrets");
    expect(client.calls[0]?.values).toEqual(["attempt:one", "worker:one", "7"]);
    expect(client.released).toBe(true);
  });
});

class Client {
  readonly calls: Array<{ text: string; values: readonly unknown[] }> = [];
  released = false;
  async query(text: string, values: readonly unknown[] = []) {
    this.calls.push({ text, values });
    if (text.includes("resolve_model_image_effect_access")) return { rows: [{
      callerAccessHandleDigest: "9432eaeb3d35fc96836055c988e45bd07ef2ef9f63c88f8f3f22f5287a4cb32a",
      callerIdentity: "platform-media-worker:one", siteId: "site:one",
      callerAudience: "platform-media-worker", workloadIdentityRef: "spiffe://kokoro/platform-media-worker",
      environment: "test", region: "local", authorizationGeneration: "7", securityEpoch: "11",
      expiresAt: "2030-01-01T00:00:00.000Z",
    }], rowCount: 1 };
    if (text.includes("resolve_model_image_option_authorization")) return { rows: [{
      authorizationHandleDigest: "0c0524a72a27631c8da35155361d40ccaa627803afa39b78a0bcf666d25456c8",
      modelOptionRevisionRef: "image-option:one", definitionRoleRef: "image.text_to_image.v1",
      deploymentRef: "deployment:one", adapterKind: "certified-image-v1",
      providerModel: "provider-model:one", expiresAt: "2030-01-01T00:00:00.000Z",
    }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  }
  release() { this.released = true; }
}

class SecretClient {
  readonly calls: Array<{ text: string; values: readonly unknown[] }> = [];
  released = false;
  async query(text: string, values: readonly unknown[] = []) {
    this.calls.push({ text, values });
    return { rows: [{ siteId: "site:one", logicalInvocationRef: "invocation:one",
      operationInputRevisionRef: "input:one", sourceGrants: { algorithm: "A256GCM", keyRevision: "test",
        nonce: "nonce", ciphertext: "ciphertext", authenticationTag: "tag" } }], rowCount: 1 };
  }
  release() { this.released = true; }
}

function transactionHarness(rows: (text: string) => readonly Record<string, unknown>[]) {
  const calls: Array<{ text: string; values: readonly unknown[] }> = [];
  const lease = issuePlatformTransaction({
    query: async <Row extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) => {
      calls.push({ text, values }); return rows(text) as readonly Row[];
    },
    execute: async (text: string, values: readonly unknown[] = []) => {
      calls.push({ text, values }); return 1;
    },
  });
  return { ...lease, calls };
}

function sourceGrantEnvelope(sourceVersionRef: string, purposeGrantHandle: string): Uint8Array {
  const source = new TextEncoder().encode(sourceVersionRef);
  const handle = new TextEncoder().encode(purposeGrantHandle);
  const result = new Uint8Array(7 + 2 + source.length + 4 + handle.length);
  result.set(new TextEncoder().encode("KIMG1"), 0);
  const view = new DataView(result.buffer);
  view.setUint16(5, 1);
  view.setUint16(7, source.length);
  result.set(source, 9);
  view.setUint32(9 + source.length, handle.length);
  result.set(handle, 13 + source.length);
  return result;
}
