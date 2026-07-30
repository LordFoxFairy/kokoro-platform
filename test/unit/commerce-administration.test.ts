import { describe, expect, it } from "vitest";
import { CommerceAdministrationService } from "../../src/modules/commerce/application/services/commerce-administration.js";
import type { CommerceAdministrationRepository } from "../../src/modules/commerce/application/contracts/commerce-administration-repository.js";
import { issuePlatformTransaction, revokePlatformTransaction } from "../../src/shared/unit-of-work/platform-transaction.js";
import type { VerifiedRequestSecurityContext } from "../../src/shared/security-context/index.js";
import { PostgresCommerceAdministrationRepository } from "../../src/modules/commerce/infrastructure/postgres/commerce-administration-repository.js";

describe("CommerceAdministrationService", () => {
  it("publishes the complete immutable offer graph through one Commerce owner transaction", async () => {
    const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 0 });
    const persisted: Parameters<CommerceAdministrationRepository["publishOffer"]>[1][] = [];
    const service = new CommerceAdministrationService({
      unitOfWork: { execute: async (_fence, work) => work(lease.transaction) },
      repository: repositoryStub({ publishOffer: async (_transaction, input) => {
        persisted.push(input);
        return { kind: "committed", occurredAt: "2026-07-29T01:00:00.000Z" };
      } }),
      codes: { issueCode: () => { throw new Error("MUST_NOT_ISSUE"); } },
    });
    try {
      await expect(service.publishOffer({
        context: context("operator-maker", "commerce.offer.publish"), siteId: "site-1",
        commandId: "00000000-0000-7000-8000-000000000210", idempotencyKey: "offer-1",
        productRef: "credits", productKind: "credit_pack", productVersionRef: "credits-v1",
        productRevision: "1", safeLabel: "1,000 credits", planVersion: null,
        fulfillmentProgramRevisionRef: "credits-fulfillment-v1", fulfillmentProgramRef: "credits-fulfillment",
        fulfillmentProgramRevision: "1", legalTermRefs: ["terms-v1"],
        outputs: [
          { outputLineId: "credits", ordinal: 0, cardinality: 1, outputKind: "credit_grant",
            targetRevisionRef: "credits-program-v1" },
          { outputLineId: "bonus", ordinal: 1, cardinality: 1, outputKind: "entitlement_grant",
            targetRevisionRef: "bonus-template-v1" },
        ],
      })).resolves.toMatchObject({ kind: "committed", productVersionRef: "credits-v1" });
      expect(persisted[0]?.outputs.map((output) => output.outputLineId)).toEqual(["credits", "bonus"]);
      expect(persisted[0]?.offerDigest).toMatch(/^[a-f0-9]{64}$/u);
    } finally { revokePlatformTransaction(lease); }
  });

  it("exports raw card secrets only on the first committed issuance response", async () => {
    const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 0 });
    let invocation = 0; let persisted: Parameters<CommerceAdministrationRepository["issueBatch"]>[1] | null = null;
    const repository = repositoryStub({ issueBatch: async (_transaction, input) => {
      persisted = input; invocation += 1;
      return { kind: invocation === 1 ? "committed" : "replayed", occurredAt: "2026-07-29T01:00:00.000Z" };
    } });
    let reference = 300;
    const service = new CommerceAdministrationService({
      unitOfWork: { execute: async (_fence, work) => work(lease.transaction) }, repository,
      reference: () => `00000000-0000-7000-8000-${String(reference++).padStart(12, "0")}`,
      codes: { issueCode: () => ({ code: "KC1-01234567-0123456789-0123456789ABCDEFGHJKMNPQRSTVWXYZ-01234567",
        keyRevision: "code-1", batchSelector: "0123456789", lookupDigest: "a".repeat(64), safeFingerprint: "CODE-0123456789ABCDEF" }) },
    });
    const input = {
      context: context("operator-maker", "commerce.code-batch.issue"), siteId: "site-1",
      commandId: "00000000-0000-7000-8000-000000000201", idempotencyKey: "issue-1",
      batchRef: "00000000-0000-7000-8000-000000000111", redemptionProgramRevisionRef: "program-v1",
      count: 2, startsAt: null, endsAt: null,
    };
    try {
      await expect(service.issueBatch(input)).resolves.toMatchObject({ kind: "secret_export", codeCount: 2, codes: expect.any(Array) });
      expect(JSON.stringify(persisted)).not.toContain("KC1-");
      await expect(service.issueBatch(input)).resolves.toEqual({
        kind: "delivery_unavailable", batchRef: input.batchRef, codeCount: 2,
        exportedAt: "2026-07-29T01:00:00.000Z",
      });
    } finally { revokePlatformTransaction(lease); }
  });

  it("requires an operator-scoped Admin workload bound to the exact Site and typed operation", async () => {
    const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 0 });
    const service = new CommerceAdministrationService({
      unitOfWork: { execute: async (_fence, work) => work(lease.transaction) }, repository: repositoryStub(),
      codes: { issueCode: () => { throw new Error("MUST_NOT_ISSUE"); } },
    });
    try {
      await expect(service.activateBatch({ context: context("operator-1", "wrong-operation"), siteId: "site-1",
        commandId: "00000000-0000-7000-8000-000000000202", idempotencyKey: "activate-1",
        batchRef: "00000000-0000-7000-8000-000000000111" })).rejects.toThrow("COMMERCE_ADMIN_NOT_AUTHORIZED");
    } finally { revokePlatformTransaction(lease); }
  });

  it("enforces maker-checker at the authoritative database write", async () => {
    const lease = issuePlatformTransaction({
      query: async (statement) => statement.includes("command_receipt") ? [{
        commandId: "00000000-0000-7000-8000-000000000203", environment: "production", region: "us-east-1",
        callerIdentity: "admin-1:operator-maker", operation: "commerce.code-batch.approve", idempotencyKey: "approve-1",
        requestDigest: "a".repeat(64), state: "pending", result: null, resultDigest: null,
      }] as never : [{ occurredAt: new Date("2026-07-29T01:00:00.000Z") }] as never,
      execute: async (statement) => statement.includes("commerce_code_batch_approval") ? 0 : 1,
    });
    try {
      await expect(new PostgresCommerceAdministrationRepository().approveBatch(lease.transaction, {
        siteId: "site-1", subjectId: "operator-maker", subjectGeneration: "1",
        batchRef: "00000000-0000-7000-8000-000000000111", approvalDigest: "b".repeat(64),
        command: { commandId: "00000000-0000-7000-8000-000000000203", environment: "production", region: "us-east-1",
          callerIdentity: "admin-1:operator-maker", operation: "commerce.code-batch.approve", idempotencyKey: "approve-1", requestDigest: "a".repeat(64) },
      })).rejects.toThrow("COMMERCE_BATCH_MAKER_CHECKER_REQUIRED");
    } finally { revokePlatformTransaction(lease); }
  });

  it.each([
    ["abandonBatch", "commerce.code-batch.abandon"],
    ["suspendBatch", "commerce.code-batch.suspend"],
    ["revokeBatch", "commerce.code-batch.revoke"],
  ] as const)("owns the %s lifecycle transition behind an exact operation", async (method, operation) => {
    const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 0 });
    const service = new CommerceAdministrationService({
      unitOfWork: { execute: async (_fence, work) => work(lease.transaction) }, repository: repositoryStub(),
      codes: { issueCode: () => { throw new Error("MUST_NOT_ISSUE"); } },
    });
    try {
      await expect(service[method]({ context: context("operator-1", operation), siteId: "site-1",
        commandId: "00000000-0000-7000-8000-000000000211", idempotencyKey: `${method}-1`,
        batchRef: "00000000-0000-7000-8000-000000000111", reason: "operator requested",
      })).resolves.toMatchObject({ kind: "committed" });
    } finally { revokePlatformTransaction(lease); }
  });
});

function repositoryStub(overrides: Partial<CommerceAdministrationRepository> = {}): CommerceAdministrationRepository {
  return {
    publishOffer: async () => ({ kind: "committed", occurredAt: "2026-07-29T01:00:00.000Z" }),
    publishProgram: async () => ({ kind: "committed", occurredAt: "2026-07-29T01:00:00.000Z" }), issueBatch: async () => ({ kind: "committed", occurredAt: "2026-07-29T01:00:00.000Z" }),
    approveBatch: async () => "committed", activateBatch: async () => "committed",
    abandonBatch: async () => "committed", suspendBatch: async () => "committed", revokeBatch: async () => "committed", ...overrides,
  };
}
function context(subjectId: string, purpose: string): VerifiedRequestSecurityContext {
  return { environment: "production", region: "us-east-1", audience: "platform-admin",
    trustedCaller: { kind: "admin_workload", workloadIdentityId: "admin-1" },
    actor: { kind: "operator", subjectId, subjectGeneration: "1" },
    target: { siteId: "site-1", purpose } } as VerifiedRequestSecurityContext;
}
