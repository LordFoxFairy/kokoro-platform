import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { PostgresCommerceAdministrationRepository } from
  "../../src/modules/commerce/infrastructure/postgres/commerce-administration-repository.js";
import { PostgresCreditGrantProgram } from
  "../../src/modules/credit/infrastructure/postgres/credit-grant-program.js";
import { issuePlatformTransaction, revokePlatformTransaction, type PlatformTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";
import { commerceCanonicalJson } from "../../src/modules/commerce/domain/canonical-json.js";

type Repository = PostgresCommerceAdministrationRepository;

const operationCases = [
  ["PublishCreditProgramRevision", "commerce.credit-program.publish",
    (repository: Repository, transaction: PlatformTransaction, input: ReplayInput) =>
      repository.publishCreditProgramRevision(transaction, input as never),
    { creditProgramRevisionRef: "credit-v1", revisionDigest: "b".repeat(64),
      publishedAt: "2026-07-30T02:00:00.000Z" }],
  ["PublishEntitlementTemplateRevision", "commerce.entitlement-template.publish",
    (repository: Repository, transaction: PlatformTransaction, input: ReplayInput) =>
      repository.publishEntitlementTemplateRevision(transaction, input as never),
    { entitlementTemplateRevisionRef: "entitlement-v1", revisionDigest: "b".repeat(64),
      publishedAt: "2026-07-30T02:00:00.000Z" }],
  ["PublishOffer", "commerce.offer.publish",
    (repository: Repository, transaction: PlatformTransaction, input: ReplayInput) =>
      repository.publishOffer(transaction, input as never),
    { productVersionRef: "offer-v1", publishedAt: "2026-07-30T02:00:00.000Z" }],
  ["PublishRedemptionProgram", "commerce.redemption-program.publish",
    (repository: Repository, transaction: PlatformTransaction, input: ReplayInput) =>
      repository.publishProgram(transaction, input as never),
    { redemptionProgramRevisionRef: "program-v1", publishedAt: "2026-07-30T02:00:00.000Z" }],
  ["IssueCodeBatch", "commerce.code-batch.issue",
    (repository: Repository, transaction: PlatformTransaction, input: ReplayInput) =>
      repository.issueBatch(transaction, input as never),
    { batchRef: "00000000-0000-7000-8000-000000000501", codeCount: 2,
      redemptionProgramRevisionRef: "program-v1", createdByOperatorRef: "operator:7",
      startsAt: null, endsAt: null, exportedAt: "2026-07-30T02:00:00.000Z" }],
  ["ApproveCodeBatch", "commerce.code-batch.approve",
    (repository: Repository, transaction: PlatformTransaction, input: ReplayInput) =>
      repository.approveBatch(transaction, input as never),
    { batchRef: "00000000-0000-7000-8000-000000000501", state: "draft",
      approvalState: "approved", changedAt: "2026-07-30T02:00:00.000Z" }],
  ["ActivateCodeBatch", "commerce.code-batch.activate",
    (repository: Repository, transaction: PlatformTransaction, input: ReplayInput) =>
      repository.activateBatch(transaction, input as never),
    { batchRef: "00000000-0000-7000-8000-000000000501", state: "active",
      approvalState: "approved", changedAt: "2026-07-30T02:00:00.000Z" }],
  ["AbandonCodeBatch", "commerce.code-batch.abandon",
    (repository: Repository, transaction: PlatformTransaction, input: ReplayInput) =>
      repository.abandonBatch(transaction, input as never),
    { batchRef: "00000000-0000-7000-8000-000000000501", state: "abandoned",
      changedAt: "2026-07-30T02:00:00.000Z" }],
  ["SuspendCodeBatch", "commerce.code-batch.suspend",
    (repository: Repository, transaction: PlatformTransaction, input: ReplayInput) =>
      repository.suspendBatch(transaction, input as never),
    { batchRef: "00000000-0000-7000-8000-000000000501", state: "suspended",
      approvalState: "approved", changedAt: "2026-07-30T02:00:00.000Z" }],
  ["RevokeCodeBatch", "commerce.code-batch.revoke",
    (repository: Repository, transaction: PlatformTransaction, input: ReplayInput) =>
      repository.revokeBatch(transaction, input as never),
    { batchRef: "00000000-0000-7000-8000-000000000501", state: "revoked",
      approvalState: "approved", changedAt: "2026-07-30T02:00:00.000Z" }],
] as const;

describe("Admin Commerce durable replay", () => {
  it.each(operationCases)("%s rejects a corrupt persisted result digest", async (_name, operation, invoke) => {
    const input = replayInput(operation);
    const statements: string[] = [];
    const lease = issuePlatformTransaction({
      execute: async (statement) => { statements.push(statement); return 0; },
      query: async (statement) => {
        statements.push(statement);
        if (!statement.includes("FROM platform.command_receipt")) {
          throw new Error("REPLAY_MUST_NOT_QUERY_BUSINESS_TABLES");
        }
        return [{ ...input.command, state: "succeeded", result: { reference: "durable-result" },
          resultDigest: "f".repeat(64), recordedAt: "2026-07-30T03:00:00.000Z" }] as never;
      },
    });
    try {
      await expect(invoke(new PostgresCommerceAdministrationRepository(new PostgresCreditGrantProgram()), lease.transaction, input))
        .rejects.toThrow("COMMERCE_ADMIN_RECEIPT_CORRUPT");
      expect(statements.filter((statement) => statement.includes("FROM platform.command_receipt"))).toHaveLength(1);
    } finally { revokePlatformTransaction(lease); }
  });

  it.each(operationCases)("%s returns only the original durable receipt and result", async (
    _name, operation, invoke, durableResult,
  ) => {
    const input = replayInput(operation); const statements: string[] = [];
    const lease = issuePlatformTransaction({
      execute: async (statement) => { statements.push(statement); return 0; },
      query: async (statement) => {
        statements.push(statement);
        if (!statement.includes("FROM platform.command_receipt")) throw new Error("REPLAY_MUST_NOT_QUERY_BUSINESS_TABLES");
        return [{ ...input.command, state: "succeeded", result: durableResult,
          resultDigest: digest(durableResult), recordedAt: "2026-07-30T03:00:00.000Z" }] as never;
      },
    });
    try {
      await expect(invoke(new PostgresCommerceAdministrationRepository(new PostgresCreditGrantProgram()), lease.transaction, input))
        .resolves.toMatchObject({ kind: "replayed", command: input.command,
          recordedAt: "2026-07-30T03:00:00.000Z", result: durableResult });
      expect(statements.filter((statement) => statement.includes("FROM platform.command_receipt"))).toHaveLength(1);
      expect(statements.some((statement) => statement.includes("commerce_code_secret_export"))).toBe(false);
    } finally { revokePlatformTransaction(lease); }
  });
});

type ReplayInput = Readonly<{
  siteId: string;
  subjectId: string;
  subjectGeneration: string;
  command: Readonly<{
    commandId: string;
    environment: string;
    region: string;
    callerIdentity: string;
    operation: string;
    idempotencyKey: string;
    requestDigest: string;
  }>;
}>;

function replayInput(operation: string): ReplayInput {
  return Object.freeze({
    siteId: "site-1", subjectId: "operator:7", subjectGeneration: "2",
    command: Object.freeze({ commandId: "00000000-0000-7000-8000-000000000401",
      environment: "production", region: "us-east-1", callerIdentity: "admin-1:operator:7",
      operation, idempotencyKey: `${operation}:idem`, requestDigest: "a".repeat(64) }),
  });
}

function digest(value: Parameters<typeof commerceCanonicalJson>[0]): string {
  return createHash("sha256").update(commerceCanonicalJson(value)).digest("hex");
}
