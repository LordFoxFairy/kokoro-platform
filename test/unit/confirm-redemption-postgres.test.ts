import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { PostgresRedemptionConfirmationRepository } from
  "../../src/modules/commerce/infrastructure/postgres/redemption-confirmation-repository.js";
import { PostgresCreditGrantIssuer } from
  "../../src/modules/credit/infrastructure/postgres/credit-grant-issuer.js";
import { issuePlatformTransaction, revokePlatformTransaction, type PlatformSqlTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";
import {
  publishedFulfillmentOutputPlanDigest,
  redemptionPreviewDigest,
  redemptionSafeTermsSchema,
  type PublishedFulfillmentOutputLine,
} from
  "../../src/modules/commerce/domain/redemption-preview.js";
import { CommerceLockSequence } from "../../src/modules/commerce/application/command-lock-order.js";
import { commerceCanonicalJson } from "../../src/modules/commerce/domain/canonical-json.js";
import type { CreditGrantProgramPort } from
  "../../src/modules/commerce/application/contracts/credit-program.js";

describe("PostgresRedemptionConfirmationRepository", () => {
  it("rejects an expired Preview before any claim or fulfillment mutation", async () => {
    const statements: string[] = [];
    const sql: PlatformSqlTransaction = {
      query: async (statement) => {
        statements.push(statement);
        if (statement.includes("FROM platform.commerce_redemption_preview preview")) {
          return [previewRow({ expiresAt: new Date("2026-07-29T00:59:59.999Z") })] as never;
        }
        return [];
      },
      execute: async (statement) => { statements.push(statement); return 1; },
    };
    const lease = issuePlatformTransaction(sql);
    try {
      await expect(confirmationRepository().confirmRedemption(
        lease.transaction,
        confirmationInput(),
        new CommerceLockSequence(),
      )).resolves.toEqual({ kind: "rejected", code: "REDEEM_NOT_ACCEPTED" });
      expect(statements.filter((statement) => /^\s*(?:INSERT|UPDATE|DELETE)\b/u.test(statement))).toEqual([]);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("rejects a Preview whose immutable digest no longer matches its stored facts", async () => {
    const statements: string[] = [];
    const lease = issuePlatformTransaction({
      query: async (statement) => {
        statements.push(statement);
        return statement.includes("FROM platform.commerce_redemption_preview preview")
          ? [previewRow({ previewDigest: "0".repeat(64) })] as never : [];
      },
      execute: async (statement) => { statements.push(statement); return 1; },
    });
    try {
      await expect(confirmationRepository().confirmRedemption(
        lease.transaction, confirmationInput(), new CommerceLockSequence(),
      )).resolves.toEqual({ kind: "rejected", code: "REDEEM_NOT_ACCEPTED" });
      expect(statements.filter((statement) => /^\s*(?:INSERT|UPDATE|DELETE)\b/u.test(statement))).toEqual([]);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("atomically claims one Code and materializes immutable entitlement fulfillment", async () => {
    const statements: string[] = [];
    const commerceCalls: string[] = [];
    const events: unknown[] = [];
    const audits: unknown[] = [];
    const output = entitlementOutput();
    const preview = validPreviewRow([output]);
    const lease = issuePlatformTransaction({
      query: async (statement) => {
        statements.push(statement);
        if (statement.includes("FROM platform.commerce_redemption_preview preview")) return [preview] as never;
        if (statement.includes("FROM platform.commerce_redemption_program_availability")) return [programRow(preview)] as never;
        if (statement.includes("FROM platform.commerce_code_batch")) return [{ state: "active", startsAt: null,
          endsAt: null, redemptionProgramRevisionRef: preview.redemptionProgramRevisionRef }] as never;
        if (statement.includes("FROM platform.commerce_redeem_code")) return [{ state: "available",
          batchRef: preview.batchRef, safeCodeFingerprint: preview.safeCodeFingerprint }] as never;
        if (statement.includes("FROM platform.commerce_billing_account account")) return [{ accountState: "active",
          membershipState: "active", subjectGeneration: 2n, redemptionCount: 0n }] as never;
        if (statement.includes("FROM platform.commerce_fulfillment_program_output")) return [output] as never;
        if (statement.includes("clock_timestamp()")) return [{ effectAt: new Date("2026-07-29T01:00:00.000Z") }] as never;
        return [];
      },
      execute: async (statement) => { statements.push(statement); return 1; },
    });
    const repository = confirmationRepository({
      commerce: {
        claimFulfillment: async (_transaction, claim) => {
          commerceCalls.push("start");
          return { disposition: "execute", fulfillmentId: claim.fulfillmentId };
        },
        commitFulfillment: async (_transaction, commit) => {
          commerceCalls.push("commit");
          return commerceReceipt(commit.claim.fulfillmentId, commit.outputs);
        },
        linkOutboxEvent: async () => { commerceCalls.push("link"); },
        recordAudit: async (_transaction, audit) => { commerceCalls.push("audit"); audits.push(audit); },
      },
      outbox: { enqueue: async (_transaction, event) => { events.push(event); } },
      reference: referenceFactory(),
    });
    try {
      const result = await repository.confirmRedemption(
        lease.transaction, confirmationInput(), new CommerceLockSequence(),
      );
      expect(result).toMatchObject({ kind: "succeeded", receipt: {
        state: "fulfilled", safeCodeFingerprint: "CODE-0123456789ABCDEF",
        outputs: [{ kind: "entitlement_grant", outputLineId: "entitlement",
          templateRevisionRef: "entitlement-v1" }],
      } });
      expect(commerceCalls).toEqual(["start", "commit", "link", "audit"]);
      expect(statements.find((statement) => statement.includes("UPDATE platform.commerce_redeem_code")))
        .toContain("state='available'");
      expect(statements.find((statement) => statement.includes("UPDATE platform.commerce_redemption_preview")))
        .toContain("state='live'");
      expect(statements.some((statement) => statement.includes("INSERT INTO platform.commerce_entitlement_grant")))
        .toBe(true);
      expect(JSON.stringify(events)).not.toContain("previewCredential");
      expect(JSON.stringify(events)).not.toContain("credentialDigest");
      const receiptDigest = result.kind === "succeeded" ? result.receipt.outputSetDigest : null;
      expect((events[0] as { payload: { outputSetDigest: string } }).payload.outputSetDigest).toBe(receiptDigest);
      expect((audits[0] as { payloadDigest: string }).payloadDigest).toBe(receiptDigest);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("issues CreditGrant and a balanced double-entry Journal under the standard account authority lock", async () => {
    const statements: string[] = [];
    const executions: Array<{ statement: string; values: readonly unknown[] }> = [];
    const output = creditOutput();
    const preview = validPreviewRow([output], {
      productRef: "product-1", productVersionRef: "product-v1", productKind: "credit_pack",
      safeProductLabel: "Credits", planRef: null, planVersionRef: null, safePlanLabel: null,
      term: { action: "none", startsAt: null, endsAt: null, automaticRenewal: false },
      credits: [{ creditProgramRevisionRef: "credit-v1", bucketClass: "permanent", unit: "credit",
        amount: "100", expiresAt: null }],
      entitlements: [], legalTermRefs: ["terms-v1"],
    });
    const lease = issuePlatformTransaction({
      query: async (statement) => {
        statements.push(statement);
        if (statement.includes("FROM platform.commerce_redemption_preview preview")) return [preview] as never;
        if (statement.includes("FROM platform.commerce_redemption_program_availability")) return [programRow(preview)] as never;
        if (statement.includes("FROM platform.commerce_code_batch")) return [{ state: "active", startsAt: null,
          endsAt: null, redemptionProgramRevisionRef: preview.redemptionProgramRevisionRef }] as never;
        if (statement.includes("FROM platform.commerce_redeem_code")) return [{ state: "available",
          batchRef: preview.batchRef, safeCodeFingerprint: preview.safeCodeFingerprint }] as never;
        if (statement.includes("FROM platform.commerce_billing_account account")) return [{ accountState: "active",
          membershipState: "active", subjectGeneration: 2n, redemptionCount: 0n }] as never;
        if (statement.includes("FROM platform.commerce_fulfillment_program_output")) return [output] as never;
        if (statement.includes("FROM platform.credit_account")) return [];
        if (statement.includes("clock_timestamp()")) return [{ effectAt: new Date("2026-07-29T01:00:00.000Z") }] as never;
        return [];
      },
      execute: async (statement, values = []) => {
        statements.push(statement);
        executions.push({ statement, values });
        return 1;
      },
    });
    const repository = confirmationRepository({
      commerce: noOpCommerce(), outbox: { enqueue: async () => undefined }, reference: referenceFactory(),
    });
    try {
      const result = await repository.confirmRedemption(
        lease.transaction, confirmationInput(), new CommerceLockSequence(),
      );
      expect(result).toMatchObject({ kind: "succeeded", receipt: { outputs: [{
        kind: "credit_grant", outputLineId: "credits", templateRevisionRef: "credit-v1",
      }] } });
      const joined = statements.join("\n");
      expect(joined).toMatch(/pg_advisory_xact_lock[\s\S]+FROM platform\.credit_account[\s\S]+FOR UPDATE/u);
      expect(joined).toContain("INSERT INTO platform.credit_account");
      expect(joined).toContain("INSERT INTO platform.credit_grant");
      expect(joined).toContain("INSERT INTO platform.credit_journal_transaction");
      expect(joined).toContain("INSERT INTO platform.credit_journal_entry");
      expect(joined).toContain("grant_issuance_source");
      expect(joined).toContain("customer_available");
      expect(joined).toMatch(/UPDATE platform\.commerce_redeem_code[\s\S]+INSERT INTO platform\.credit_grant[\s\S]+INSERT INTO platform\.credit_journal_transaction/u);
      const grantInsert = executions.find(({ statement }) => statement.includes("INSERT INTO platform.credit_grant"))!;
      expect(grantInsert.values[17]).toBe("2026-07-29T01:00:00.000Z");
      expect(grantInsert.values[18]).toBeNull();
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it.each(["daily", "period"] as const)(
    "rejects a %s Credit preview before locking or mutating authorities",
    async (bucketClass) => {
      const statements: string[] = [];
      const output = { ...creditOutput(), bucketClass, creditExpiresAfterSeconds: 86400n };
      const preview = validPreviewRow([output], {
        productRef: "product-1", productVersionRef: "product-v1", productKind: "credit_pack",
        safeProductLabel: "Credits", planRef: null, planVersionRef: null, safePlanLabel: null,
        term: { action: "none", startsAt: null, endsAt: null, automaticRenewal: false },
        credits: [{ creditProgramRevisionRef: "credit-v1", bucketClass, unit: "credit",
          amount: "100", expiresAt: "2026-07-30T00:59:00.000Z" }],
        entitlements: [], legalTermRefs: ["terms-v1"],
      });
      const lease = issuePlatformTransaction({
        query: async (statement) => {
          statements.push(statement);
          return statement.includes("FROM platform.commerce_redemption_preview preview") ? [preview] as never : [];
        },
        execute: async (statement) => { statements.push(statement); return 1; },
      });
      try {
        await expect(confirmationRepository().confirmRedemption(
          lease.transaction, confirmationInput(), new CommerceLockSequence(),
        )).resolves.toEqual({ kind: "rejected", code: "REDEEM_NOT_ACCEPTED" });
        expect(statements).toHaveLength(1);
        expect(statements.filter((statement) => /^\s*(?:INSERT|UPDATE|DELETE)\b/u.test(statement))).toEqual([]);
      } finally {
        revokePlatformTransaction(lease);
      }
    },
  );

  it("locks the subscription authority and creates an immutable non-renewing term", async () => {
    const statements: string[] = [];
    const output = subscriptionOutput();
    const preview = validPreviewRow([output], {
      productRef: "product-1", productVersionRef: "product-v1", productKind: "subscription",
      safeProductLabel: "Pro", planRef: "plan-1", planVersionRef: "plan-v1", safePlanLabel: "Pro monthly",
      term: { action: "new_subscription", startsAt: "2026-07-29T00:59:00.000Z",
        endsAt: "2026-07-30T00:59:00.000Z", automaticRenewal: false },
      credits: [], entitlements: [], legalTermRefs: ["terms-v1"],
    });
    const lease = issuePlatformTransaction({
      query: async (statement) => {
        statements.push(statement);
        if (statement.includes("FROM platform.commerce_redemption_preview preview")) return [preview] as never;
        if (statement.includes("FROM platform.commerce_redemption_program_availability")) return [{
          ...programRow(preview), stackingScope: "plan:pro", termAction: "new_subscription", termSeconds: 86400n,
        }] as never;
        if (statement.includes("FROM platform.commerce_catalog_plan")) return [{ planRef: "plan-1", state: "active" }] as never;
        if (statement.includes("FROM platform.commerce_code_batch")) return [{ state: "active", startsAt: null,
          endsAt: null, redemptionProgramRevisionRef: preview.redemptionProgramRevisionRef }] as never;
        if (statement.includes("FROM platform.commerce_redeem_code")) return [{ state: "available",
          batchRef: preview.batchRef, safeCodeFingerprint: preview.safeCodeFingerprint }] as never;
        if (statement.includes("FROM platform.commerce_billing_account account")) return [{ accountState: "active",
          membershipState: "active", subjectGeneration: 2n, redemptionCount: 0n }] as never;
        if (statement.includes("FROM platform.commerce_subscription subscription")) return [];
        if (statement.includes("FROM platform.commerce_fulfillment_program_output")) return [output] as never;
        if (statement.includes("clock_timestamp()")) return [{ effectAt: new Date("2026-07-29T01:00:00.000Z") }] as never;
        return [];
      },
      execute: async (statement) => { statements.push(statement); return 1; },
    });
    const repository = confirmationRepository({
      commerce: noOpCommerce(), outbox: { enqueue: async () => undefined }, reference: referenceFactory(),
    });
    try {
      const result = await repository.confirmRedemption(
        lease.transaction, confirmationInput(), new CommerceLockSequence(),
      );
      expect(result).toMatchObject({ kind: "succeeded", receipt: { outputs: [{
        kind: "subscription_term", outputLineId: "term", templateRevisionRef: "plan-v1",
      }] } });
      const joined = statements.join("\n");
      expect(joined).toMatch(/FROM platform\.commerce_subscription subscription[\s\S]+FOR UPDATE/u);
      expect(joined).toContain("INSERT INTO platform.commerce_subscription");
      expect(joined).toContain("INSERT INTO platform.commerce_subscription_term");
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("reloads the durable failed command cursor without exposing rejection details", async () => {
    const lease = issuePlatformTransaction({
      query: async (statement) => statement.includes("FROM platform.command_receipt receipt") ? [{
        state: "failed", commandReceivedAt: new Date("2026-07-29T00:59:58.000Z"),
        commandUpdatedAt: new Date("2026-07-29T00:59:59.000Z"),
      }] as never : [],
      execute: async () => 0,
    });
    try {
      await expect(confirmationRepository().findConfirmationByCommand(
        lease.transaction, commandLookup(),
      )).resolves.toEqual({ state: "failed", commandReceivedAt: "2026-07-29T00:59:58.000Z",
        commandUpdatedAt: "2026-07-29T00:59:59.000Z", code: "REDEEM_NOT_ACCEPTED" });
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("rebuilds a fulfilled receipt from immutable Redemption and fulfillment outputs", async () => {
    const output = entitlementReceipt();
    const lease = issuePlatformTransaction({
      query: async (statement) => {
        if (statement.includes("FROM platform.command_receipt receipt")) return [{
          state: "succeeded", commandReceivedAt: new Date("2026-07-29T00:59:58.000Z"),
          commandUpdatedAt: new Date("2026-07-29T01:00:01.000Z"),
        }] as never;
        if (statement.includes("WITH fulfillment_source AS")) return [];
        if (statement.includes("FROM platform.commerce_redemption redemption")) return [{
          commandId: confirmationInput().commandId,
          redemptionId: "00000000-0000-7000-8000-000000000301",
          fulfillmentRef: "00000000-0000-7000-8000-000000000302",
          outputSetDigest: outputSetDigest([output]),
          fulfillmentIdempotencyKey: "redeem:command-1",
          planRef: null, planVersionRef: null,
          productRef: "product-1", productVersionRef: "product-v1",
          redeemedAt: new Date("2026-07-29T01:00:00.000Z"), safeCodeFingerprint: "CODE-0123456789ABCDEF",
          state: "fulfilled", stateObservedAt: new Date("2026-07-29T01:00:00.000Z"),
        }] as never;
        if (statement.includes("FROM platform.commerce_fulfillment_actual_output actual")) return [output] as never;
        if (statement.includes("FROM platform.commerce_redemption_reversal")) return [];
        return [];
      },
      execute: async () => 0,
    });
    try {
      await expect(confirmationRepository().findConfirmationByCommand(
        lease.transaction, commandLookup(),
      )).resolves.toMatchObject({ state: "succeeded", receipt: {
        commandUpdatedAt: "2026-07-29T01:00:01.000Z", state: "fulfilled",
        outputs: [{ kind: "entitlement_grant", outputLineId: "entitlement" }], reversalRefs: [],
      } });
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("recovers a command cursor only by the authenticated actor's idempotency key", async () => {
    const statements: string[] = [];
    const lease = issuePlatformTransaction({
      query: async (statement) => {
        statements.push(statement);
        if (statement.includes("receipt.idempotency_key")) return [{
          commandId: confirmationInput().commandId, requestDigest: "d".repeat(64), state: "pending",
          commandReceivedAt: new Date("2026-07-29T01:00:00.000Z"),
          commandUpdatedAt: new Date("2026-07-29T01:00:01.000Z"),
        }] as never;
        return [];
      },
      execute: async () => 0,
    });
    try {
      await expect(confirmationRepository().findConfirmationByIdempotencyKey(
        lease.transaction,
        { siteId: "site-1", subjectId: "subject-1", subjectGeneration: "2", idempotencyKey: "confirm-1" },
      )).resolves.toEqual({
        commandId: confirmationInput().commandId, requestDigest: "d".repeat(64),
        confirmation: { state: "pending", commandReceivedAt: "2026-07-29T01:00:00.000Z",
          commandUpdatedAt: "2026-07-29T01:00:01.000Z" },
      });
      expect(statements[0]).toContain("command.actor_subject=$2");
      expect(statements[0]).toContain("command.actor_generation=$3::bigint");
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("loads a receipt by Redemption id with actor ownership and canonical output ordering", async () => {
    const statements: string[] = [];
    const output = entitlementReceipt();
    const lease = issuePlatformTransaction({
      query: async (statement) => {
        statements.push(statement);
        if (statement.includes("redemption.redemption_id=$1::uuid")) return [{
          commandId: confirmationInput().commandId,
          redemptionId: "00000000-0000-7000-8000-000000000301",
          fulfillmentRef: "00000000-0000-7000-8000-000000000302",
          outputSetDigest: outputSetDigest([output]), fulfillmentIdempotencyKey: "redeem:command-1",
          planRef: null, planVersionRef: null,
          productRef: "product-1", productVersionRef: "product-v1",
          redeemedAt: new Date("2026-07-29T01:00:00.000Z"), safeCodeFingerprint: "CODE-0123456789ABCDEF",
          state: "fulfilled", stateObservedAt: new Date("2026-07-29T01:00:00.000Z"),
        }] as never;
        if (statement.includes("FROM platform.commerce_fulfillment_actual_output actual")) return [output] as never;
        return [];
      },
      execute: async () => 0,
    });
    try {
      await expect(confirmationRepository().findRedemptionReceipt(
        lease.transaction,
        { siteId: "site-1", subjectId: "subject-1", subjectGeneration: "2",
          redemptionId: "00000000-0000-7000-8000-000000000301" },
      )).resolves.toMatchObject({ outputs: [output], state: "fulfilled" });
      expect(statements[0]).toContain("command.actor_subject=$3");
      expect(statements[1]).toContain("ORDER BY expected.ordinal,actual.occurrence");
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("rechecks Preview and availability deadlines against DB time after acquiring claim locks", async () => {
    const statements: string[] = [];
    const output = entitlementOutput();
    const preview = validPreviewRow([output]);
    const lease = issuePlatformTransaction({
      query: async (statement) => {
        statements.push(statement);
        if (statement.includes("FROM platform.commerce_redemption_preview preview")) return [preview] as never;
        if (statement.includes("FROM platform.commerce_redemption_program_availability")) return [programRow(preview)] as never;
        if (statement.includes("FROM platform.commerce_code_batch")) return [{ state: "active", startsAt: null,
          endsAt: null, redemptionProgramRevisionRef: preview.redemptionProgramRevisionRef }] as never;
        if (statement.includes("FROM platform.commerce_redeem_code")) return [{ state: "available",
          batchRef: preview.batchRef, safeCodeFingerprint: preview.safeCodeFingerprint }] as never;
        if (statement.includes("FROM platform.commerce_billing_account account")) return [{ accountState: "active",
          membershipState: "active", subjectGeneration: 2n, redemptionCount: 0n }] as never;
        if (statement.includes("FROM platform.commerce_fulfillment_program_output")) return [output] as never;
        if (statement.includes("clock_timestamp()")) return [{ effectAt: new Date("2026-07-29T01:05:00.000Z") }] as never;
        return [];
      },
      execute: async (statement) => { statements.push(statement); return 1; },
    });
    try {
      await expect(confirmationRepository({
        commerce: noOpCommerce(), outbox: { enqueue: async () => undefined }, reference: referenceFactory(),
      }).confirmRedemption(lease.transaction, confirmationInput(), new CommerceLockSequence()))
        .resolves.toEqual({ kind: "rejected", code: "REDEEM_NOT_ACCEPTED" });
      expect(statements.filter((statement) => /^\s*(?:INSERT|UPDATE|DELETE)\b/u.test(statement))).toEqual([]);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("locks and rejects a disabled Plan before claiming a subscription Code", async () => {
    const statements: string[] = [];
    const output = subscriptionOutput();
    const preview = validPreviewRow([output], {
      productRef: "product-1", productVersionRef: "product-v1", productKind: "subscription",
      safeProductLabel: "Pro", planRef: "plan-1", planVersionRef: "plan-v1", safePlanLabel: "Pro monthly",
      term: { action: "new_subscription", startsAt: "2026-07-29T00:59:00.000Z",
        endsAt: "2026-07-30T00:59:00.000Z", automaticRenewal: false },
      credits: [], entitlements: [], legalTermRefs: ["terms-v1"],
    });
    const lease = issuePlatformTransaction({
      query: async (statement) => {
        statements.push(statement);
        if (statement.includes("FROM platform.commerce_redemption_preview preview")) return [preview] as never;
        if (statement.includes("FROM platform.commerce_redemption_program_availability")) return [{
          ...programRow(preview), stackingScope: "plan:pro", termAction: "new_subscription", termSeconds: 86400n,
        }] as never;
        if (statement.includes("FROM platform.commerce_catalog_plan")) return [{ planRef: "plan-1", state: "disabled" }] as never;
        if (statement.includes("FROM platform.commerce_code_batch")) return [{ state: "active", startsAt: null,
          endsAt: null, redemptionProgramRevisionRef: preview.redemptionProgramRevisionRef }] as never;
        if (statement.includes("FROM platform.commerce_redeem_code")) return [{ state: "available",
          batchRef: preview.batchRef, safeCodeFingerprint: preview.safeCodeFingerprint }] as never;
        if (statement.includes("FROM platform.commerce_billing_account account")) return [{ accountState: "active",
          membershipState: "active", subjectGeneration: 2n, redemptionCount: 0n }] as never;
        if (statement.includes("FROM platform.commerce_subscription subscription")) return [];
        if (statement.includes("FROM platform.commerce_fulfillment_program_output")) return [output] as never;
        if (statement.includes("clock_timestamp()")) return [{ effectAt: new Date("2026-07-29T01:00:00.000Z") }] as never;
        return [];
      },
      execute: async (statement) => { statements.push(statement); return 1; },
    });
    try {
      await expect(confirmationRepository({
        commerce: noOpCommerce(), outbox: { enqueue: async () => undefined }, reference: referenceFactory(),
      }).confirmRedemption(lease.transaction, confirmationInput(), new CommerceLockSequence()))
        .resolves.toEqual({ kind: "rejected", code: "REDEEM_NOT_ACCEPTED" });
      expect(statements.some((statement) =>
        statement.includes("FROM platform.commerce_catalog_plan") && statement.includes("FOR UPDATE"))).toBe(true);
      expect(statements.filter((statement) => /^\s*(?:INSERT|UPDATE|DELETE)\b/u.test(statement))).toEqual([]);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("rejects an existing Subscription owned by another Plan in the same stacking scope", async () => {
    const statements: string[] = [];
    const output = subscriptionOutput();
    const preview = validPreviewRow([output], {
      productRef: "product-1", productVersionRef: "product-v1", productKind: "subscription",
      safeProductLabel: "Pro", planRef: "plan-1", planVersionRef: "plan-v1", safePlanLabel: "Pro monthly",
      term: { action: "new_subscription", startsAt: "2026-07-29T00:59:00.000Z",
        endsAt: "2026-07-30T00:59:00.000Z", automaticRenewal: false },
      credits: [], entitlements: [], legalTermRefs: ["terms-v1"],
    });
    const lease = issuePlatformTransaction({
      query: async (statement) => {
        statements.push(statement);
        if (statement.includes("FROM platform.commerce_redemption_preview preview")) return [preview] as never;
        if (statement.includes("FROM platform.commerce_redemption_program_availability")) return [{
          ...programRow(preview), stackingScope: "shared-scope", termAction: "new_subscription", termSeconds: 86400n,
        }] as never;
        if (statement.includes("FROM platform.commerce_catalog_plan")) return [{ planRef: "plan-1", state: "active" }] as never;
        if (statement.includes("FROM platform.commerce_code_batch")) return [{ state: "active", startsAt: null,
          endsAt: null, redemptionProgramRevisionRef: preview.redemptionProgramRevisionRef }] as never;
        if (statement.includes("FROM platform.commerce_redeem_code")) return [{ state: "available",
          batchRef: preview.batchRef, safeCodeFingerprint: preview.safeCodeFingerprint }] as never;
        if (statement.includes("FROM platform.commerce_billing_account account")) return [{ accountState: "active",
          membershipState: "active", subjectGeneration: 2n, redemptionCount: 0n }] as never;
        if (statement.includes("FROM platform.commerce_subscription subscription")) return [{
          subscriptionId: "00000000-0000-7000-8000-000000000901", state: "active",
          planRef: "plan-other", activeTermEndsAt: null,
        }] as never;
        if (statement.includes("FROM platform.commerce_fulfillment_program_output")) return [output] as never;
        if (statement.includes("clock_timestamp()")) return [{ effectAt: new Date("2026-07-29T01:00:00.000Z") }] as never;
        return [];
      },
      execute: async (statement) => { statements.push(statement); return 1; },
    });
    try {
      await expect(confirmationRepository({
        commerce: noOpCommerce(), outbox: { enqueue: async () => undefined }, reference: referenceFactory(),
      }).confirmRedemption(lease.transaction, confirmationInput(), new CommerceLockSequence()))
        .resolves.toEqual({ kind: "rejected", code: "REDEEM_NOT_ACCEPTED" });
      expect(statements.filter((statement) => /^\s*(?:INSERT|UPDATE|DELETE)\b/u.test(statement))).toEqual([]);
    } finally {
      revokePlatformTransaction(lease);
    }
  });
});

function confirmationRepository(
  dependencies: Omit<ConstructorParameters<typeof PostgresRedemptionConfirmationRepository>[0],
    "creditGrants" | "creditPrograms" | "creditCorrections"> = {},
) {
  return new PostgresRedemptionConfirmationRepository({
    creditGrants: new PostgresCreditGrantIssuer(),
    creditPrograms: creditPrograms(),
    creditCorrections: { listCorrectionRefs: async () => Object.freeze([]) },
    ...dependencies,
  });
}

function confirmationInput() {
  return {
    siteId: "site-1", subjectId: "subject-1", subjectGeneration: "2",
    commandId: "00000000-0000-7000-8000-000000000201",
    previewRef: "00000000-0000-7000-8000-000000000101",
    credentialKeyRevision: "preview-1", credentialDigest: "c".repeat(64),
    legalAcceptanceRefs: ["terms-v1"], authorityReleaseRef: "release-1",
    workloadIdentityId: "workload-1", confirmedAt: "2026-07-29T01:00:00.000Z",
  } as const;
}

function commandLookup() {
  return { siteId: "site-1", subjectId: "subject-1", subjectGeneration: "2",
    commandId: confirmationInput().commandId } as const;
}

function previewRow(overrides: Record<string, unknown> = {}) {
  return {
    previewRef: "00000000-0000-7000-8000-000000000101",
    siteId: "site-1", subjectId: "subject-1", subjectGeneration: 2n,
    billingAccountId: "billing-1", codeRef: "00000000-0000-7000-8000-000000000401",
    batchRef: "00000000-0000-7000-8000-000000000402",
    redemptionProgramRevisionRef: "redeem-program-v1", fulfillmentProgramRevisionRef: "fulfill-v1",
    productRevisionDigest: "1".repeat(64), programDigest: "2".repeat(64),
    outputPlanDigest: "3".repeat(64), previewDigest: "4".repeat(64),
    credentialKeyRevision: "preview-1", credentialDigest: "c".repeat(64),
    safeCodeFingerprint: "CODE-0123456789ABCDEF", state: "live",
    expiresAt: new Date("2026-07-29T01:05:00.000Z"), createdAt: new Date("2026-07-29T00:59:00.000Z"),
    safeTerms: {
      productRef: "product-1", productVersionRef: "product-v1", productKind: "free",
      safeProductLabel: "Starter", planRef: null, planVersionRef: null, safePlanLabel: null,
      term: { action: "none", startsAt: null, endsAt: null, automaticRenewal: false },
      credits: [], entitlements: [{ entitlementTemplateRevisionRef: "entitlement-v1",
        capabilityKey: "chat.basic", safeLabel: "Chat", expiresAt: null }], legalTermRefs: ["terms-v1"],
    },
    ...overrides,
  };
}

function validPreviewRow(
  outputs: readonly PublishedFulfillmentOutputLine[],
  safeTerms?: Record<string, unknown>,
) {
  const row = previewRow(safeTerms === undefined ? {} : { safeTerms });
  row.outputPlanDigest = publishedFulfillmentOutputPlanDigest({
    siteId: row.siteId,
    fulfillmentProgramRevisionRef: row.fulfillmentProgramRevisionRef,
    lines: outputs,
  });
  row.previewDigest = redemptionPreviewDigest({
    siteId: row.siteId, subjectId: row.subjectId, subjectGeneration: row.subjectGeneration.toString(),
    billingAccountId: row.billingAccountId,
    candidate: {
      codeRef: row.codeRef, batchRef: row.batchRef,
      redemptionProgramRevisionRef: row.redemptionProgramRevisionRef,
      fulfillmentProgramRevisionRef: row.fulfillmentProgramRevisionRef,
      productRevisionDigest: row.productRevisionDigest, programDigest: row.programDigest,
      outputPlanDigest: row.outputPlanDigest, safeCodeFingerprint: row.safeCodeFingerprint,
      safeTerms: redemptionSafeTermsSchema.parse(row.safeTerms),
    },
    expiresAt: row.expiresAt.toISOString(),
  });
  return row;
}

function entitlementOutput() {
  return {
    outputLineId: "entitlement", outputKind: "entitlement_grant" as const, ordinal: 1, cardinality: 1,
    ownerRevision: 1n, ownerRevisionDigest: "e".repeat(64),
    planVersionRef: null, creditProgramRevisionRef: null, creditProgramRevisionVersion: null,
    creditProgramRevisionDigest: null, bucketClass: null, unit: null, amount: null,
    creditExpiresAfterSeconds: null, entitlementTemplateRevisionRef: "entitlement-v1",
    capabilityKey: "chat.basic", safeLabel: "Chat", entitlementExpiresAfterSeconds: null,
  };
}

function creditOutput() {
  return {
    outputLineId: "credits", outputKind: "credit_grant" as const, ordinal: 1, cardinality: 1,
    ownerRevision: 1n, ownerRevisionDigest: "c".repeat(64),
    planVersionRef: null, creditProgramRevisionRef: "credit-v1", creditProgramRevisionVersion: 1n,
    creditProgramRevisionDigest: "c".repeat(64), bucketClass: "permanent" as const,
    unit: "credit", amount: "100", creditExpiresAfterSeconds: null,
    liabilityMerchantAccountId: "merchant-1", burnPriority: 100, scopePolicy: {
      version: 1, surfaceRefs: ["general.chat"], capabilityKeys: ["general.chat.message"],
      agentRefs: [], allowUnattributedAgent: true,
    },
    entitlementTemplateRevisionRef: null, capabilityKey: null, safeLabel: null,
    entitlementExpiresAfterSeconds: null,
  };
}

function subscriptionOutput() {
  return {
    outputLineId: "term", outputKind: "subscription_term" as const, ordinal: 1, cardinality: 1,
    ownerRevision: 1n, ownerRevisionDigest: "d".repeat(64),
    planVersionRef: "plan-v1", creditProgramRevisionRef: null, creditProgramRevisionVersion: null,
    creditProgramRevisionDigest: null, bucketClass: null,
    unit: null, amount: null, creditExpiresAfterSeconds: null,
    liabilityMerchantAccountId: null, burnPriority: null, scopePolicy: null,
    entitlementTemplateRevisionRef: null, capabilityKey: null, safeLabel: null,
    entitlementExpiresAfterSeconds: null,
  };
}

function creditPrograms(): CreditGrantProgramPort {
  return {
    resolveTargets: async (_transaction, input) => input.targets.map((target) => Object.freeze({
      ...target,
      bucketClass: "permanent" as const,
      unit: "credit",
      amount: "100",
      expiresAfterSeconds: null,
      windowKind: "none" as const, calendarZone: null, windowAnchor: null,
      liabilityMerchantAccountId: "merchant-1",
      burnPriority: 100,
      scopePolicy: Object.freeze({ version: 1 as const, surfaceRefs: ["general.chat"],
        capabilityKeys: ["general.chat.message"], agentRefs: [], allowUnattributedAgent: true }),
    })),
    resolveRefs: async (_transaction, input) => input.revisionRefs.map((revisionRef) => Object.freeze({
      revisionRef,
      revision: 1n,
      revisionDigest: "c".repeat(64),
      bucketClass: "permanent" as const,
      unit: "credit",
      amount: "100",
      expiresAfterSeconds: null,
      windowKind: "none" as const, calendarZone: null, windowAnchor: null,
      liabilityMerchantAccountId: "merchant-1",
      burnPriority: 100,
      scopePolicy: Object.freeze({ version: 1 as const, surfaceRefs: ["general.chat"],
        capabilityKeys: ["general.chat.message"], agentRefs: [], allowUnattributedAgent: true }),
    })),
    publishRevision: async () => undefined,
  };
}

function programRow(preview: ReturnType<typeof previewRow>) {
  return {
    availabilityState: "active", startsAt: null, endsAt: null,
    redemptionProgramRevisionRef: preview.redemptionProgramRevisionRef,
    programDigest: preview.programDigest, maxRedemptionsPerAccount: 1,
    productState: "active", productRef: preview.safeTerms.productRef,
    productVersionRef: preview.safeTerms.productVersionRef, planRef: preview.safeTerms.planRef,
    planVersionRef: preview.safeTerms.planVersionRef,
    productRevisionDigest: preview.productRevisionDigest,
    fulfillmentProgramRevisionRef: preview.fulfillmentProgramRevisionRef,
    fulfillmentProgramRevision: 1n,
    outputPlanDigest: preview.outputPlanDigest, stackingScope: null,
  };
}

function referenceFactory() {
  let index = 0;
  return () => `00000000-0000-7000-8000-${(++index).toString().padStart(12, "0")}`;
}

function noOpCommerce() {
  return {
    claimFulfillment: async (_transaction: unknown, claim: { fulfillmentId: string }) =>
      ({ disposition: "execute" as const, fulfillmentId: claim.fulfillmentId }),
    commitFulfillment: async (_transaction: unknown, commit: { claim: { fulfillmentId: string };
      outputs: Parameters<typeof commerceReceipt>[1] }) =>
      commerceReceipt(commit.claim.fulfillmentId, commit.outputs),
    linkOutboxEvent: async () => undefined,
    recordAudit: async () => undefined,
  };
}

function commerceReceipt(
  fulfillmentId: string,
  outputs: readonly Readonly<{ outputKind: "subscription" | "subscription_term" | "entitlement_grant" | "credit_grant" |
    "credit_program_enrollment";
    outputLineId: string; outputOrdinal: number; occurrence: number; outputRef: string;
    templateRevision: string; outputVersion: 1; outputDigest: string }>[],
) {
  const receipts = outputs.map((output) => Object.freeze({
    kind: output.outputKind === "subscription" ? "subscription_term" as const : output.outputKind,
    outputLineId: output.outputLineId, outputOrdinal: output.outputOrdinal, occurrence: output.occurrence,
    resourceRef: output.outputRef, templateRevisionRef: output.templateRevision,
    outputVersion: output.outputVersion, outputDigest: output.outputDigest,
  }));
  return Object.freeze({ fulfillmentId, transactionVersion: 1 as const,
    transactionDigest: "f".repeat(64), outputSetDigest: outputSetDigest(receipts), outputs: receipts });
}

function outputSetDigest(outputs: readonly Record<string, unknown>[]): string {
  return createHash("sha256").update(commerceCanonicalJson({ version: 1, outputs }), "utf8").digest("hex");
}

function entitlementReceipt() {
  const commitment = { kind: "entitlement_grant" as const, outputLineId: "entitlement",
    outputOrdinal: 1, occurrence: 1, resourceRef: "00000000-0000-7000-8000-000000000303",
    templateRevisionRef: "entitlement-v1", outputVersion: 1 as const };
  return Object.freeze({ ...commitment, outputDigest: createHash("sha256").update(commerceCanonicalJson({
    version: 1, ...commitment,
  }), "utf8").digest("hex") });
}
