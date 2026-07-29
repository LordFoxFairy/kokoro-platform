import { describe, expect, it } from "vitest";
import { zConfirmRedemptionResponse } from
  "../../src/interfaces/http/generated/platform-public/zod.gen.js";
import { ConfirmRedemptionService } from
  "../../src/modules/commerce/application/services/confirm-redemption.js";
import type {
  RedemptionConfirmationRepository,
  StoredRedemptionConfirmation,
  StoredRedemptionReceipt,
} from "../../src/modules/commerce/application/contracts/redemption-confirmation-repository.js";
import { createRedemptionSecretCodec } from
  "../../src/modules/commerce/infrastructure/crypto/redemption-secret-codec.js";
import { CommerceApplicationError } from
  "../../src/modules/commerce/application/commerce-application-error.js";
import { CommerceLockSequence } from "../../src/workflows/commerce/lock-order.js";
import { issuePlatformTransaction, revokePlatformTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";
import type { PlatformTransaction } from "../../src/shared/unit-of-work/platform-transaction.js";
import type { VerifiedRequestSecurityContext } from
  "../../src/shared/security-context/index.js";

describe("ConfirmRedemptionService", () => {
  it("binds a fresh confirmation to capability, Site, subject generation, account preview and legal set", async () => {
    const repository = new FakeConfirmationRepository();
    const harness = serviceHarness(repository);
    try {
      const result = await harness.service.execute(confirmInput(harness.previewCredential));
      expect(zConfirmRedemptionResponse.parse(result)).toEqual(result);
      expect(result).toMatchObject({ kind: "succeeded", redemption: {
        redemptionId: "00000000-0000-7000-8000-000000000301", state: "fulfilled",
      } });
      expect(repository.confirmed).toMatchObject({
        siteId: "site-1", subjectId: "subject-1", subjectGeneration: "2",
        previewRef: "00000000-0000-7000-8000-000000000101",
        legalAcceptanceRefs: ["terms-v1"], authorityReleaseRef: "release-1",
        workloadIdentityId: "workload-1",
      });
      expect(repository.confirmed?.credentialDigest).toMatch(/^[a-f0-9]{64}$/u);
    } finally {
      harness.close();
    }
  });

  it("fails closed before opening a command transaction for an invalid preview capability", async () => {
    const repository = new FakeConfirmationRepository();
    const harness = serviceHarness(repository);
    try {
      await expect(harness.service.execute(confirmInput(`${harness.previewCredential}x`)))
        .rejects.toEqual(expect.objectContaining<Partial<CommerceApplicationError>>({ code: "REDEEM_NOT_ACCEPTED" }));
      expect(harness.fence.executions).toBe(0);
      expect(repository.confirmed).toBeNull();
    } finally {
      harness.close();
    }
  });

  it("returns a durable safe rejection for a valid but no-longer-claimable preview", async () => {
    const repository = new FakeConfirmationRepository();
    repository.result = { kind: "rejected", code: "REDEEM_NOT_ACCEPTED" };
    const harness = serviceHarness(repository);
    try {
      const result = await harness.service.execute(confirmInput(harness.previewCredential));
      expect(zConfirmRedemptionResponse.parse(result)).toEqual(result);
      expect(result).toMatchObject({ kind: "rejected", rejection: {
        code: "REDEEM_NOT_ACCEPTED", retryClass: "never", retryAfter: null,
      } });
    } finally {
      harness.close();
    }
  });

  it("reloads the committed command receipt after a fresh fulfillment", async () => {
    const repository = new FakeConfirmationRepository();
    repository.storedReceipt = { ...receipt(), commandUpdatedAt: "2026-07-29T01:00:01.000Z" };
    const harness = serviceHarness(repository);
    try {
      const result = await harness.service.execute(confirmInput(harness.previewCredential));
      expect(result.command.updatedAt).toBe("2026-07-29T01:00:01.000Z");
      expect(repository.finds).toBe(1);
    } finally {
      harness.close();
    }
  });

  it("uses the durable command cursor when replaying a terminal rejection", async () => {
    const repository = new FakeConfirmationRepository();
    repository.commandState = {
      state: "failed", commandReceivedAt: "2026-07-29T00:59:58.000Z",
      commandUpdatedAt: "2026-07-29T00:59:59.000Z", code: "REDEEM_NOT_ACCEPTED",
    };
    const harness = serviceHarness(repository);
    harness.fence.replay = { state: "failed", result: {
      kind: "redemption_rejected", code: "REDEEM_NOT_ACCEPTED", rejectedAt: "2026-07-29T00:59:57.000Z",
    }, resultDigest: "b".repeat(64) };
    try {
      const result = await harness.service.execute(confirmInput(harness.previewCredential));
      expect(result).toMatchObject({ kind: "rejected", command: {
        receivedAt: "2026-07-29T00:59:58.000Z", updatedAt: "2026-07-29T00:59:59.000Z",
      } });
      expect(repository.commandFinds).toBe(1);
    } finally {
      harness.close();
    }
  });
});

class FakeConfirmationRepository implements RedemptionConfirmationRepository {
  confirmed: Parameters<RedemptionConfirmationRepository["confirmRedemption"]>[1] | null = null;
  finds = 0;
  commandFinds = 0;
  storedReceipt: StoredRedemptionReceipt = receipt();
  commandState: StoredRedemptionConfirmation | null = null;
  result: Awaited<ReturnType<RedemptionConfirmationRepository["confirmRedemption"]>> = {
    kind: "succeeded", receipt: receipt(),
  };

  async confirmRedemption(
    _transaction: Parameters<RedemptionConfirmationRepository["confirmRedemption"]>[0],
    input: Parameters<RedemptionConfirmationRepository["confirmRedemption"]>[1],
  ): ReturnType<RedemptionConfirmationRepository["confirmRedemption"]> {
    this.confirmed = input;
    return this.result;
  }

  async findConfirmationByCommand(): Promise<StoredRedemptionConfirmation | null> {
    this.finds += 1;
    this.commandFinds += 1;
    if (this.commandState !== null) return this.commandState;
    if (this.result.kind === "rejected") return {
      state: "failed", commandReceivedAt: "2026-07-29T01:00:00.000Z",
      commandUpdatedAt: "2026-07-29T01:00:00.000Z", code: this.result.code,
    };
    return { state: "succeeded", receipt: this.storedReceipt };
  }
}

function serviceHarness(repository: RedemptionConfirmationRepository) {
  const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 0 });
  const fence = new FakeFence(lease.transaction);
  const secrets = createRedemptionSecretCodec({
    currentCodeLookupKeyRevision: "code-1", codeLookupKeys: [{ keyRevision: "code-1", key: Buffer.alloc(32, 1) }],
    currentPreviewCredentialKeyRevision: "preview-1",
    previewCredentialKeys: [{ keyRevision: "preview-1", key: Buffer.alloc(32, 2) }],
    requestAuditKey: Buffer.alloc(32, 3),
  });
  const previewCredential = secrets.previewCredential("00000000-0000-7000-8000-000000000101");
  return {
    previewCredential,
    fence,
    service: new ConfirmRedemptionService({
      unitOfWork: { execute: async (_fence, work) => work(lease.transaction) },
      fence,
      repository,
      secrets,
      clock: () => new Date("2026-07-29T01:00:00.000Z"),
    }),
    close: () => revokePlatformTransaction(lease),
  };
}

class FakeFence {
  executions = 0;
  replay: { state: string; result: Record<string, string> | null; resultDigest: string | null } | null = null;
  constructor(private readonly transaction: Parameters<RedemptionConfirmationRepository["confirmRedemption"]>[0]) {}

  async execute(
    _input: unknown,
    work: (input: { transaction: PlatformTransaction; authority: { siteId: string; releaseRef: string; subjectId: string }; locks: CommerceLockSequence }) => Promise<{ state: "succeeded" | "failed"; result: never; resultDigest: string }>,
  ) {
    this.executions += 1;
    if (this.replay !== null) return { disposition: "replay" as const, receipt: this.replay };
    const outcome = await work({ transaction: this.transaction,
      authority: { siteId: "site-1", releaseRef: "release-1", subjectId: "subject-1" },
      locks: new CommerceLockSequence() });
    return { disposition: "executed" as const, ...outcome };
  }
}

function confirmInput(previewCredential: string) {
  return { context: context(), commandId: "00000000-0000-7000-8000-000000000201",
    idempotencyKey: "confirm-operation-0001", previewCredential,
    legalAcceptanceRefs: ["terms-v1"] } as const;
}

function context(): VerifiedRequestSecurityContext {
  return {
    environment: "test", region: "local", audience: "site-1",
    trustedCaller: { kind: "site_product", siteId: "site-1", workloadIdentityId: "workload-1",
      siteReleaseRef: "release-1" },
    actor: { kind: "user", subjectId: "subject-1", subjectGeneration: "2" },
    target: { siteId: "site-1", purpose: "confirmRedemption" },
  } as VerifiedRequestSecurityContext;
}

function receipt(): StoredRedemptionReceipt {
  return {
    commandId: "00000000-0000-7000-8000-000000000201",
    commandReceivedAt: "2026-07-29T01:00:00.000Z", commandUpdatedAt: "2026-07-29T01:00:00.000Z",
    redemptionId: "00000000-0000-7000-8000-000000000301",
    fulfillmentRef: "00000000-0000-7000-8000-000000000302", outputSetDigest: "a".repeat(64),
    outputs: [{ kind: "credit_grant", outputLineId: "credits", resourceRef: "00000000-0000-7000-8000-000000000303",
      templateRevisionRef: "credit-v1" }],
    planRef: null, planVersionRef: null, productRef: "product-1", productVersionRef: "product-v1",
    redeemedAt: "2026-07-29T01:00:00.000Z", safeCodeFingerprint: "CODE-0123456789ABCDEF",
    state: "fulfilled", stateObservedAt: "2026-07-29T01:00:00.000Z", reversalRefs: [],
  };
}
