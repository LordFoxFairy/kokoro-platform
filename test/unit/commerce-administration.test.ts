import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { CommerceAdministrationService } from "../../src/modules/commerce/application/services/commerce-administration.js";
import type { CommerceAdministrationRepository } from "../../src/modules/commerce/application/contracts/commerce-administration-repository.js";
import { issuePlatformTransaction, revokePlatformTransaction } from "../../src/shared/unit-of-work/platform-transaction.js";
import type { VerifiedRequestSecurityContext } from "../../src/shared/security-context/index.js";
import { PostgresCommerceAdministrationRepository } from "../../src/modules/commerce/infrastructure/postgres/commerce-administration-repository.js";
import { commerceCanonicalJson } from "../../src/modules/commerce/domain/canonical-json.js";

describe("CommerceAdministrationService", () => {
  it("publishes an immutable Site-scoped CreditProgram revision before an offer references it", async () => {
    const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 0 });
    const persisted: Parameters<CommerceAdministrationRepository["publishCreditProgramRevision"]>[1][] = [];
    const service = new CommerceAdministrationService({
      unitOfWork: { execute: async (_fence, work) => work(lease.transaction) },
      repository: repositoryStub({ publishCreditProgramRevision: async (_transaction, input) => {
        persisted.push(input);
        return { kind: "committed", command: input.command, recordedAt: "2026-07-30T01:00:01.000Z", result: {
          creditProgramRevisionRef: input.creditProgramRevisionRef,
          revisionDigest: input.revisionDigest, publishedAt: "2026-07-30T01:00:00.000Z",
        } };
      } }),
      codes: { issueCode: () => { throw new Error("MUST_NOT_ISSUE"); } },
    });
    try {
      await expect(service.publishCreditProgramRevision({
        context: context("operator-maker", "commerce.credit-program.publish"), siteId: "site-1",
        commandId: "00000000-0000-7000-8000-000000000220", idempotencyKey: "credit-program-1",
        creditProgramRevisionRef: "credits-program-v1", programRef: "credits-program", revision: "1",
        uxBucketClass: "permanent", unit: "kokoro-credit", amount: "1000", burnPriority: 1000,
        scopePolicy: { surfaceRefs: ["chat"], capabilityKeys: ["model.chat"], agentRefs: [],
          allowUnattributedAgent: true },
        liabilityMerchantAccountRef: "merchant:main", rolloverPolicy: "none",
        calendarZone: null, windowAnchor: null,
        expiresAfterSeconds: null,
      })).resolves.toMatchObject({ kind: "committed", creditProgramRevisionRef: "credits-program-v1" });
      expect(persisted[0]).toMatchObject({ windowKind: "none", revisionDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        scopePolicy: { version: 1, surfaceRefs: ["chat"], capabilityKeys: ["model.chat"] } });
    } finally { revokePlatformTransaction(lease); }
  });

  it("rejects incomplete recurring CreditProgram window facts before opening a transaction", async () => {
    const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 0 });
    const publish = vi.fn();
    const service = new CommerceAdministrationService({
      unitOfWork: { execute: async (_fence, work) => work(lease.transaction) },
      repository: repositoryStub({ publishCreditProgramRevision: publish }),
      codes: { issueCode: () => { throw new Error("MUST_NOT_ISSUE"); } },
    });
    try {
      await expect(service.publishCreditProgramRevision({
        context: context("operator-maker", "commerce.credit-program.publish"), siteId: "site-1",
        commandId: "00000000-0000-7000-8000-000000000221", idempotencyKey: "credit-program-2",
        creditProgramRevisionRef: "daily-program-v1", programRef: "daily-program", revision: "1",
        uxBucketClass: "daily", unit: "kokoro-credit", amount: "25", burnPriority: 100,
        scopePolicy: { surfaceRefs: ["chat"], capabilityKeys: ["model.chat"], agentRefs: [],
          allowUnattributedAgent: true },
        liabilityMerchantAccountRef: "merchant:main", rolloverPolicy: "none", calendarZone: null,
        windowAnchor: "00:00", expiresAfterSeconds: "86400",
      })).rejects.toThrow("COMMERCE_CREDIT_WINDOW_INVALID");
      expect(publish).not.toHaveBeenCalled();
    } finally { revokePlatformTransaction(lease); }
  });

  it.each([
    ["Not/AZone", "daily@00:00:00"],
    ["America/New_York", "daily@24:00:00"],
    ["America/New_York", "subscription-term-start"],
  ])("rejects a non-executable daily window (%s, %s)", async (calendarZone, windowAnchor) => {
    const publish = vi.fn();
    const service = new CommerceAdministrationService({
      unitOfWork: { execute: async () => { throw new Error("MUST_NOT_OPEN_TRANSACTION"); } },
      repository: repositoryStub({ publishCreditProgramRevision: publish }),
      codes: { issueCode: () => { throw new Error("MUST_NOT_ISSUE"); } },
    });
    await expect(service.publishCreditProgramRevision({
      context: context("operator-maker", "commerce.credit-program.publish"), siteId: "site-1",
      commandId: "00000000-0000-7000-8000-000000000224", idempotencyKey: "credit-window-invalid",
      creditProgramRevisionRef: "daily-program-v1", programRef: "daily-program", revision: "1",
      uxBucketClass: "daily", unit: "kokoro-credit", amount: "25", burnPriority: 100,
      scopePolicy: { surfaceRefs: ["chat"], capabilityKeys: ["model.chat"], agentRefs: [],
        allowUnattributedAgent: true },
      liabilityMerchantAccountRef: "merchant:main", rolloverPolicy: "none",
      calendarZone, windowAnchor, expiresAfterSeconds: "86400",
    })).rejects.toThrow("COMMERCE_CREDIT_WINDOW_INVALID");
    expect(publish).not.toHaveBeenCalled();
  });

  it.each(["Premium\u202Echat", "Premium\nchat", "Cafe\u0301", " Premium chat"])(
    "rejects an unsafe or non-NFC display label (%s)", async (safeLabel) => {
      const publish = vi.fn();
      const service = new CommerceAdministrationService({
        unitOfWork: { execute: async () => { throw new Error("MUST_NOT_OPEN_TRANSACTION"); } },
        repository: repositoryStub({ publishEntitlementTemplateRevision: publish }),
        codes: { issueCode: () => { throw new Error("MUST_NOT_ISSUE"); } },
      });
      await expect(service.publishEntitlementTemplateRevision({
        context: context("operator-maker", "commerce.entitlement-template.publish"), siteId: "site-1",
        commandId: "00000000-0000-7000-8000-000000000225", idempotencyKey: "unsafe-label",
        entitlementTemplateRevisionRef: "premium-chat-v1", templateRef: "premium-chat", revision: "1",
        capabilityKey: "chat.premium", safeLabel, expiresAfterSeconds: null,
      })).rejects.toThrow("COMMERCE_ADMIN_LABEL_INVALID");
      expect(publish).not.toHaveBeenCalled();
    },
  );

  it("publishes a typed EntitlementTemplate revision as a separate immutable prerequisite", async () => {
    const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 0 });
    const persisted: Parameters<CommerceAdministrationRepository["publishEntitlementTemplateRevision"]>[1][] = [];
    const service = new CommerceAdministrationService({
      unitOfWork: { execute: async (_fence, work) => work(lease.transaction) },
      repository: repositoryStub({ publishEntitlementTemplateRevision: async (_transaction, input) => {
        persisted.push(input);
        return { kind: "committed", command: input.command, recordedAt: "2026-07-30T01:00:01.000Z", result: {
          entitlementTemplateRevisionRef: input.entitlementTemplateRevisionRef,
          revisionDigest: input.revisionDigest, publishedAt: "2026-07-30T01:00:00.000Z",
        } };
      } }),
      codes: { issueCode: () => { throw new Error("MUST_NOT_ISSUE"); } },
    });
    try {
      await expect(service.publishEntitlementTemplateRevision({
        context: context("operator-maker", "commerce.entitlement-template.publish"), siteId: "site-1",
        commandId: "00000000-0000-7000-8000-000000000222", idempotencyKey: "entitlement-template-1",
        entitlementTemplateRevisionRef: "premium-chat-v1", templateRef: "premium-chat", revision: "1",
        capabilityKey: "chat.premium", safeLabel: "Premium chat", expiresAfterSeconds: null,
      })).resolves.toMatchObject({ kind: "committed", entitlementTemplateRevisionRef: "premium-chat-v1" });
      expect(persisted[0]?.revisionDigest).toMatch(/^[a-f0-9]{64}$/u);
    } finally { revokePlatformTransaction(lease); }
  });

  it("publishes the complete immutable offer graph through one Commerce owner transaction", async () => {
    const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 0 });
    const persisted: Parameters<CommerceAdministrationRepository["publishOffer"]>[1][] = [];
    const service = new CommerceAdministrationService({
      unitOfWork: { execute: async (_fence, work) => work(lease.transaction) },
      repository: repositoryStub({ publishOffer: async (_transaction, input) => {
        persisted.push(input);
        return { kind: "committed", command: input.command, recordedAt: "2026-07-29T01:00:01.000Z",
          result: { productVersionRef: input.productVersionRef, publishedAt: "2026-07-29T01:00:00.000Z" } };
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
      const result = { batchRef: input.batchRef, codeCount: input.count,
        redemptionProgramRevisionRef: input.redemptionProgramRevisionRef,
        createdByOperatorRef: input.subjectId, startsAt: input.startsAt, endsAt: input.endsAt,
        exportedAt: "2026-07-29T01:00:00.000Z" };
      if (invocation === 1) {
        const material = input.issueCodes();
        return { kind: "committed", command: input.command, recordedAt: "2026-07-29T01:00:01.000Z",
          result, rawCodes: material.rawCodes };
      }
      return { kind: "replayed", command: input.command, recordedAt: "2026-07-29T01:00:01.000Z", result };
    } });
    let reference = 300;
    const issueCode = vi.fn(() => ({ code: "KC1-01234567-0123456789-0123456789ABCDEFGHJKMNPQRSTVWXYZ-01234567",
      keyRevision: "code-1", batchSelector: "0123456789", lookupDigest: "a".repeat(64),
      safeFingerprint: "CODE-0123456789ABCDEF" }));
    const service = new CommerceAdministrationService({
      unitOfWork: { execute: async (_fence, work) => work(lease.transaction) }, repository,
      reference: () => `00000000-0000-7000-8000-${String(reference++).padStart(12, "0")}`,
      codes: { issueCode },
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
      await expect(service.issueBatch(input)).resolves.toMatchObject({
        kind: "delivery_unavailable", batchRef: input.batchRef, codeCount: 2,
        exportedAt: "2026-07-29T01:00:00.000Z",
      });
      expect(issueCode).toHaveBeenCalledTimes(2);
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
        recordedAt: "2026-07-29T01:00:00.000Z",
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

  it("persists a CreditProgram prerequisite with command receipt and audit in one transaction", async () => {
    const statements: string[] = [];
    const identity = { commandId: "00000000-0000-7000-8000-000000000223",
      environment: "production", region: "us-east-1", callerIdentity: "admin-1:operator-maker",
      operation: "commerce.credit-program.publish", idempotencyKey: "credit-program-3",
      requestDigest: "a".repeat(64) };
    let recorded = false;
    const lease = issuePlatformTransaction({
      query: async (statement) => {
        statements.push(statement);
        if (statement.includes("FROM platform.command_receipt")) return [{ ...identity,
          result: recorded ? { creditProgramRevisionRef: "credits-program-v1",
            revisionDigest: "b".repeat(64), publishedAt: "2026-07-30T01:00:00.000Z" } : null,
          resultDigest: recorded ? digestResult({ creditProgramRevisionRef: "credits-program-v1",
            revisionDigest: "b".repeat(64), publishedAt: "2026-07-30T01:00:00.000Z" }) : null,
          state: recorded ? "succeeded" : "pending", recordedAt: "2026-07-30T01:00:01.000Z" }] as never;
        if (statement.includes("commerce_catalog_epoch_authority")) return [{ catalogEpoch: "42" }] as never;
        return [{ occurredAt: new Date("2026-07-30T01:00:00.000Z") }] as never;
      },
      execute: async (statement) => { statements.push(statement);
        if (statement.includes("UPDATE platform.command_receipt")) recorded = true;
        return 1; },
    });
    try {
      await expect(new PostgresCommerceAdministrationRepository().publishCreditProgramRevision(lease.transaction, {
        siteId: "site-1", subjectId: "operator-maker", subjectGeneration: "1", command: identity,
        creditProgramRevisionRef: "credits-program-v1", programRef: "credits-program", revision: "1",
        uxBucketClass: "permanent", unit: "kokoro-credit", amount: "1000", burnPriority: 1000,
        scopePolicy: { version: 1, surfaceRefs: ["chat"], capabilityKeys: ["model.chat"],
          agentRefs: [], allowUnattributedAgent: true }, liabilityMerchantAccountRef: "merchant:main",
        rolloverPolicy: "none",
        windowKind: "none", calendarZone: null, windowAnchor: null, expiresAfterSeconds: null,
        revisionDigest: "b".repeat(64),
      })).resolves.toMatchObject({ kind: "committed", result: {
        publishedAt: "2026-07-30T01:00:00.000Z" } });
      expect(statements.some((statement) => statement.includes(
        "INSERT INTO platform.commerce_credit_program_revision"))).toBe(true);
      expect(statements.some((statement) => statement.includes(
        "UPDATE platform.commerce_catalog_epoch_authority"))).toBe(true);
      expect(statements.some((statement) => statement.includes(
        "catalog_epoch,published_at"))).toBe(true);
      expect(statements.some((statement) => statement.includes("INSERT INTO platform.commerce_audit_entry"))).toBe(true);
      expect(statements.some((statement) => statement.includes("UPDATE platform.command_receipt"))).toBe(true);
    } finally { revokePlatformTransaction(lease); }
  });

  it("rejects commandId drift even when idempotency key and digest match", async () => {
    const persistedCommandId = "00000000-0000-7000-8000-000000000226";
    const retryCommandId = "00000000-0000-7000-8000-000000000227";
    const identity = {
      commandId: retryCommandId, environment: "production", region: "us-east-1",
      callerIdentity: "admin-1:operator-maker", operation: "commerce.credit-program.publish",
      idempotencyKey: "credit-program-replay", requestDigest: "a".repeat(64),
    };
    const persistedResult = { creditProgramRevisionRef: "credits-program-v1",
      revisionDigest: "b".repeat(64), publishedAt: "2026-07-30T01:00:00.000Z" };
    const statements: string[] = [];
    const lease = issuePlatformTransaction({
      query: async (statement) => {
        statements.push(statement);
        if (statement.includes("FROM platform.command_receipt")) return [{ ...identity,
          commandId: persistedCommandId, state: "succeeded", result: persistedResult,
          resultDigest: digestResult(persistedResult), recordedAt: "2026-07-30T01:00:01.000Z" }] as never;
        throw new Error("REPLAY_MUST_NOT_RECONSTRUCT_RESULT_FROM_BUSINESS_TABLE");
      },
      execute: async (statement) => { statements.push(statement); return 0; },
    });
    try {
      await expect(new PostgresCommerceAdministrationRepository().publishCreditProgramRevision(
        lease.transaction, {
          siteId: "site-1", subjectId: "operator-maker", subjectGeneration: "1", command: identity,
          creditProgramRevisionRef: "credits-program-v1", programRef: "credits-program", revision: "1",
          uxBucketClass: "permanent", unit: "kokoro-credit", amount: "1000", burnPriority: 1000,
          scopePolicy: { version: 1, surfaceRefs: ["chat"], capabilityKeys: ["model.chat"],
            agentRefs: [], allowUnattributedAgent: true }, liabilityMerchantAccountRef: "merchant:main",
          windowKind: "none", rolloverPolicy: "none", calendarZone: null, windowAnchor: null,
          expiresAfterSeconds: null, revisionDigest: "b".repeat(64),
        },
      )).rejects.toThrow("COMMAND_IDENTITY_CONFLICT");
      expect(statements.filter((statement) => statement.includes("FROM platform.command_receipt"))).toHaveLength(1);
      expect(statements.some((statement) => statement.includes("commerce_command"))).toBe(false);
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
  const command = { commandId: "00000000-0000-7000-8000-000000000299", environment: "production",
    region: "us-east-1", callerIdentity: "admin-1:operator-maker", operation: "commerce.catalog.publish",
    idempotencyKey: "catalog-stub", requestDigest: "a".repeat(64) };
  return {
    publishCreditProgramRevision: async (_transaction, input) => ({ kind: "committed", command,
      recordedAt: "2026-07-29T01:00:01.000Z",
      result: { creditProgramRevisionRef: input.creditProgramRevisionRef,
        revisionDigest: input.revisionDigest, publishedAt: "2026-07-29T01:00:00.000Z" } }),
    publishEntitlementTemplateRevision: async (_transaction, input) => ({ kind: "committed", command,
      recordedAt: "2026-07-29T01:00:01.000Z",
      result: { entitlementTemplateRevisionRef: input.entitlementTemplateRevisionRef,
        revisionDigest: input.revisionDigest, publishedAt: "2026-07-29T01:00:00.000Z" } }),
    publishOffer: async (_transaction, input) => ({ kind: "committed", command: input.command,
      recordedAt: "2026-07-29T01:00:01.000Z",
      result: { productVersionRef: input.productVersionRef, publishedAt: "2026-07-29T01:00:00.000Z" } }),
    publishProgram: async (_transaction, input) => ({ kind: "committed", command: input.command,
      recordedAt: "2026-07-29T01:00:01.000Z", result: {
        redemptionProgramRevisionRef: input.redemptionProgramRevisionRef, publishedAt: "2026-07-29T01:00:00.000Z" } }),
    issueBatch: async (_transaction, input) => { const material = input.issueCodes(); return {
      kind: "committed", command: input.command, recordedAt: "2026-07-29T01:00:01.000Z",
      result: { batchRef: input.batchRef, codeCount: input.count,
        redemptionProgramRevisionRef: input.redemptionProgramRevisionRef,
        createdByOperatorRef: input.subjectId, startsAt: input.startsAt, endsAt: input.endsAt,
        exportedAt: "2026-07-29T01:00:00.000Z" }, rawCodes: material.rawCodes }; },
    approveBatch: async (_transaction, input) => batchOutcome(input.command, input.batchRef, "draft", true),
    activateBatch: async (_transaction, input) => batchOutcome(input.command, input.batchRef, "active", true),
    abandonBatch: async (_transaction, input) => batchOutcome(input.command, input.batchRef, "abandoned", false),
    suspendBatch: async (_transaction, input) => batchOutcome(input.command, input.batchRef, "suspended", true),
    revokeBatch: async (_transaction, input) => batchOutcome(input.command, input.batchRef, "revoked", true), ...overrides,
  };
}
function batchOutcome(command: Parameters<CommerceAdministrationRepository["approveBatch"]>[1]["command"],
  batchRef: string, state: "draft" | "active" | "abandoned" | "suspended" | "revoked", approved: boolean) {
  return { kind: "committed" as const, command, recordedAt: "2026-07-29T01:00:01.000Z",
    result: { batchRef, state, ...(approved ? { approvalState: "approved" as const } : {}),
      changedAt: "2026-07-29T01:00:00.000Z" } };
}
function digestResult(value: Parameters<typeof commerceCanonicalJson>[0]): string {
  return createHash("sha256").update(commerceCanonicalJson(value)).digest("hex");
}
function context(subjectId: string, purpose: string): VerifiedRequestSecurityContext {
  return { environment: "production", region: "us-east-1", audience: "platform-admin",
    trustedCaller: { kind: "admin_workload", workloadIdentityId: "admin-1" },
    actor: { kind: "operator", subjectId, subjectGeneration: "1" },
    target: { siteId: "site-1", purpose } } as VerifiedRequestSecurityContext;
}
