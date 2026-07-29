import { describe, expect, it } from "vitest";
import { RedemptionQueryService } from
  "../../src/modules/commerce/application/services/redemption-query.js";
import type { RedemptionConfirmationRepository } from
  "../../src/modules/commerce/application/contracts/redemption-confirmation-repository.js";
import { CommerceApplicationError } from
  "../../src/modules/commerce/application/commerce-application-error.js";
import { issuePlatformTransaction, revokePlatformTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";
import type { VerifiedRequestSecurityContext } from "../../src/shared/security-context/index.js";

describe("RedemptionQueryService", () => {
  it("recovers the authenticated user's command by idempotency key with its durable request digest", async () => {
    const repository = new QueryRepository();
    repository.recovered = {
      commandId: "00000000-0000-7000-8000-000000000201",
      requestDigest: "a".repeat(64),
      confirmation: {
        state: "pending", commandReceivedAt: "2026-07-29T01:00:00.000Z",
        commandUpdatedAt: "2026-07-29T01:00:01.000Z",
      },
    };
    const harness = queryHarness(repository);
    try {
      await expect(harness.service.recoverCommand({
        context: context("recoverRedemptionCommand"), idempotencyKey: "confirm-1",
      })).resolves.toMatchObject({
        kind: "executing",
        command: { commandId: "00000000-0000-7000-8000-000000000201", requestDigest: "a".repeat(64) },
      });
      expect(repository.recoveryInput).toEqual({
        siteId: "site-1", subjectId: "subject-1", subjectGeneration: "2", idempotencyKey: "confirm-1",
      });
      expect(harness.authorized).toEqual(["recoverRedemptionCommand"]);
    } finally {
      harness.close();
    }
  });

  it("returns only a Site and subject-owned immutable redemption receipt", async () => {
    const repository = new QueryRepository();
    repository.receipt = receipt();
    const harness = queryHarness(repository);
    try {
      await expect(harness.service.getReceipt({
        context: context("getRedemptionReceipt"), redemptionId: receipt().redemptionId,
      })).resolves.toEqual({ redemption: receipt() });
      expect(repository.receiptInput).toMatchObject({
        siteId: "site-1", subjectId: "subject-1", subjectGeneration: "2",
      });
      expect(harness.authorized).toEqual(["getRedemptionReceipt"]);
    } finally {
      harness.close();
    }
  });

  it("uses the same non-disclosing not-found result for missing recovery and receipt", async () => {
    const harness = queryHarness(new QueryRepository());
    try {
      await expect(harness.service.recoverCommand({
        context: context("recoverRedemptionCommand"), idempotencyKey: "missing",
      })).rejects.toEqual(expect.objectContaining<Partial<CommerceApplicationError>>({ code: "REDEMPTION_NOT_FOUND" }));
      await expect(harness.service.getReceipt({
        context: context("getRedemptionReceipt"), redemptionId: receipt().redemptionId,
      })).rejects.toEqual(expect.objectContaining<Partial<CommerceApplicationError>>({ code: "REDEMPTION_NOT_FOUND" }));
    } finally {
      harness.close();
    }
  });
});

class QueryRepository implements RedemptionConfirmationRepository {
  recovered: Awaited<ReturnType<RedemptionConfirmationRepository["findConfirmationByIdempotencyKey"]>> = null;
  receipt: Awaited<ReturnType<RedemptionConfirmationRepository["findRedemptionReceipt"]>> = null;
  recoveryInput: Parameters<RedemptionConfirmationRepository["findConfirmationByIdempotencyKey"]>[1] | null = null;
  receiptInput: Parameters<RedemptionConfirmationRepository["findRedemptionReceipt"]>[1] | null = null;

  async confirmRedemption(): ReturnType<RedemptionConfirmationRepository["confirmRedemption"]> {
    throw new Error("UNEXPECTED_MUTATION");
  }
  async findConfirmationByCommand() { return null; }
  async findConfirmationByIdempotencyKey(
    _transaction: Parameters<RedemptionConfirmationRepository["findConfirmationByIdempotencyKey"]>[0],
    input: Parameters<RedemptionConfirmationRepository["findConfirmationByIdempotencyKey"]>[1],
  ) {
    this.recoveryInput = input;
    return this.recovered;
  }
  async findRedemptionReceipt(
    _transaction: Parameters<RedemptionConfirmationRepository["findRedemptionReceipt"]>[0],
    input: Parameters<RedemptionConfirmationRepository["findRedemptionReceipt"]>[1],
  ) {
    this.receiptInput = input;
    return this.receipt;
  }
}

function queryHarness(repository: RedemptionConfirmationRepository) {
  const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 0 });
  const authorized: string[] = [];
  return {
    service: new RedemptionQueryService({
      repository,
      unitOfWork: { execute: async (_fence, work) => work(lease.transaction) },
      authorizeRead: async (_transaction, _context, operation) => {
        authorized.push(operation);
        return { siteId: "site-1", releaseRef: "release-1", subjectId: "subject-1" };
      },
    }),
    authorized,
    close: () => revokePlatformTransaction(lease),
  };
}

function context(purpose: "recoverRedemptionCommand" | "getRedemptionReceipt"): VerifiedRequestSecurityContext {
  return {
    environment: "test", region: "local", audience: "site-1",
    trustedCaller: { kind: "site_product", siteId: "site-1", workloadIdentityId: "workload-1",
      siteReleaseRef: "release-1" },
    actor: { kind: "user", subjectId: "subject-1", subjectGeneration: "2" },
    target: { siteId: "site-1", purpose },
  } as VerifiedRequestSecurityContext;
}

function receipt() {
  return {
    commandId: "00000000-0000-7000-8000-000000000201",
    redemptionId: "00000000-0000-7000-8000-000000000301",
    fulfillmentRef: "00000000-0000-7000-8000-000000000302",
    outputSetDigest: "a".repeat(64), outputs: [], planRef: null, planVersionRef: null,
    productRef: "product-1", productVersionRef: "product-v1",
    redeemedAt: "2026-07-29T01:00:00.000Z", safeCodeFingerprint: "CODE-0123456789ABCDEF",
    state: "fulfilled" as const, stateObservedAt: "2026-07-29T01:00:00.000Z", reversalRefs: [],
  };
}
