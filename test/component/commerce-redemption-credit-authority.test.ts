import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import {
  COMMERCE_PUBLIC_LOCK_ROUTINES,
} from "../../src/infrastructure/postgres/commerce-public-lock-routines.js";
import {
  createPlatformDatabaseClient,
  loadPlatformDatabaseConfig,
  type PlatformTransactionalDatabaseClient,
} from "../../src/infrastructure/postgres/client.js";
import { runPlatformMigrations } from "../../src/infrastructure/postgres/migrator.js";
import { createFrozenFulfillmentSnapshot, createFulfillmentSourceIdentity } from
  "../../src/modules/commerce/domain/fulfillment-source.js";
import { PostgresCommerceRepository } from
  "../../src/modules/commerce/infrastructure/postgres/repository.js";
import {
  createCommercePublicApplicationComposition,
  loadRedemptionSecretCodec,
} from "../../src/process/platform-public-composition.js";
import type { VerifiedRequestSecurityContext } from
  "../../src/shared/security-context/request-security-context.js";
import { PlatformUnitOfWork } from "../../src/shared/unit-of-work/index.js";
import { resolvePlatformTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";
import {
  cleanupCommerceRedemptionFixture,
  commercePublicContext,
  provisionCommerceRedemptionFixture,
  type CommerceRedemptionFixture,
} from "./support/commerce-redemption-fixture.js";

const migratorUrl = leased(process.env.DATABASE_URL_PLATFORM_MIGRATOR_TEST);
const bootstrapUrl = leased(process.env.DATABASE_URL_PLATFORM_BOOTSTRAP_TEST);
const adminUrl = leased(process.env.DATABASE_URL_PLATFORM_ADMIN_TEST);
const apiUrl = leased(process.env.DATABASE_URL_PLATFORM_API_TEST);
const migratorRole = role(process.env.PLATFORM_DATABASE_MIGRATOR_ROLE);
const adminRole = role(process.env.PLATFORM_DATABASE_ADMIN_ROLE);
const apiRole = role(process.env.PLATFORM_DATABASE_API_ROLE);
const databaseName = new URL(migratorUrl).pathname.slice(1);

describe("Commerce redemption-to-credit PostgreSQL authority", () => {
  it("redeems one Admin-issued code into one replay-safe fulfillment and balanced Credit Grant", async () => {
    await runPlatformMigrations({ environment: { ...process.env,
      DATABASE_URL_PLATFORM: migratorUrl, PLATFORM_DATABASE_CREDENTIAL_CLASS: "migrator" } });
    const bootstrap = new Client({ connectionString: bootstrapUrl });
    const admin = createPlatformDatabaseClient(loadPlatformDatabaseConfig("admin", {
      DATABASE_URL_PLATFORM: adminUrl,
      PLATFORM_DATABASE_CREDENTIAL_CLASS: "admin",
      PLATFORM_DATABASE_ADMIN_ROLE: adminRole,
      PLATFORM_DATABASE_MIGRATOR_ROLE: migratorRole,
      PLATFORM_DATABASE_EXPECTED_DATABASE: databaseName,
    }));
    const api = createPlatformDatabaseClient(loadPlatformDatabaseConfig("api", {
      DATABASE_URL_PLATFORM: apiUrl,
      PLATFORM_DATABASE_CREDENTIAL_CLASS: "api",
      PLATFORM_DATABASE_API_ROLE: apiRole,
      PLATFORM_DATABASE_MIGRATOR_ROLE: migratorRole,
      PLATFORM_DATABASE_EXPECTED_DATABASE: databaseName,
    }));
    const wrongRole = new Client({ connectionString: adminUrl });
    let fixture: CommerceRedemptionFixture | undefined;
    await Promise.all([bootstrap.connect(), wrongRole.connect(), admin.connect(), api.connect()]);
    try {
      const routinePrivileges = await bootstrap.query<{
        api_can_execute: boolean;
        admin_can_execute: boolean;
        public_can_execute: boolean;
      }>(
        `SELECT bool_and(has_function_privilege($1,routine,'EXECUTE')) AS api_can_execute,
                bool_or(has_function_privilege($2,routine,'EXECUTE')) AS admin_can_execute,
                bool_or(has_function_privilege('public',routine,'EXECUTE')) AS public_can_execute
         FROM unnest($3::text[]) routine`,
        [apiRole, adminRole, COMMERCE_PUBLIC_LOCK_ROUTINES],
      );
      expect(routinePrivileges.rows).toEqual([{
        api_can_execute: true,
        admin_can_execute: false,
        public_can_execute: false,
      }]);
      await expect(wrongRole.query(
        "SELECT * FROM platform.lock_commerce_command_authority($1,$2,$3,$4)",
        ["wrong-workload", "wrong-site", "wrong-subject", "wrong-session"],
      )).rejects.toMatchObject({ code: "42501" });

      fixture = await provisionCommerceRedemptionFixture({ bootstrap, admin });
      const secrets = await loadRedemptionSecretCodec(fixture.secretsPath);
      const production = createCommercePublicApplicationComposition({ database: api, secrets });
      const rawCode = required(fixture.rawCodes[0], "COMMERCE_COMPONENT_RAW_CODE_REQUIRED");

      const previewCommandId = commandId(); fixture.commandIds.push(previewCommandId);
      const previewInput = Object.freeze({
        context: await commercePublicContext(fixture, "previewRedemption"),
        commandId: previewCommandId,
        idempotencyKey: `preview:${previewCommandId}`,
        code: rawCode,
      });
      const preview = await production.preview.execute(previewInput);
      expect(preview.preview).toMatchObject({
        productVersionRef: fixture.productVersionRef,
        credits: [{ bucketClass: "permanent", unit: "credit_minor", amount: "1000", expiresAt: null }],
        legalTermRefs: [],
      });
      await expect(production.preview.execute(previewInput)).resolves.toEqual(preview);

      const confirmCommandId = commandId(); fixture.commandIds.push(confirmCommandId);
      const confirmInput = Object.freeze({
        context: await commercePublicContext(fixture, "confirmRedemption"),
        commandId: confirmCommandId,
        idempotencyKey: `confirm:${confirmCommandId}`,
        previewCredential: preview.preview.previewCredential,
        legalAcceptanceRefs: Object.freeze([]),
      });
      const confirmation = await production.confirm.execute(confirmInput);
      if (confirmation.kind !== "succeeded") throw new Error("COMMERCE_COMPONENT_CONFIRMATION_REQUIRED");
      expect(confirmation.redemption).toMatchObject({
        state: "fulfilled",
        productVersionRef: fixture.productVersionRef,
        outputs: [{ kind: "credit_grant", outputLineId: "credits" }],
      });
      const grantOutput = required(
        confirmation.redemption.outputs.find((output) => output.kind === "credit_grant"),
        "COMMERCE_COMPONENT_GRANT_REQUIRED",
      );
      const grantId = grantOutput.resourceRef;
      const committedFacts = await readFacts(bootstrap, fixture.siteId);
      expect(committedFacts).toMatchObject({
        previewCount: 1,
        claimedCodeCount: 1,
        redemptionCount: 1,
        fulfillmentCount: 1,
        fulfillmentPlanCount: 1,
        fulfillmentOutputCount: 1,
        creditAccountCount: 1,
        creditGrantCount: 1,
        grantJournalCount: 1,
        grantJournalEntryCount: 2,
        grantJournalDebitCount: 1,
        grantJournalCreditCount: 1,
        grantJournalDebitTotal: "1000",
        grantJournalCreditTotal: "1000",
        availableBalance: "1000",
        outboxCount: 1,
        commandOutboxCount: 1,
        auditCount: 1,
        grantSourceType: "redemption",
      });

      await expect(production.confirm.execute(confirmInput)).resolves.toEqual(confirmation);
      await expect(production.queries.recoverCommand({
        context: await commercePublicContext(fixture, "recoverRedemptionCommand"),
        idempotencyKey: confirmInput.idempotencyKey,
      })).resolves.toEqual(confirmation);
      await expect(production.queries.getReceipt({
        context: await commercePublicContext(fixture, "getRedemptionReceipt"),
        redemptionId: confirmation.redemption.redemptionId,
      })).resolves.toEqual({ redemption: confirmation.redemption });

      const grant = await production.accountQueries.getCreditGrant({
        context: await commercePublicContext(fixture, "getCreditGrant"),
        grantId,
      });
      expect(grant.grant).toMatchObject({ grantId, unit: "credit_minor", bucketClass: "permanent",
        issued: "1000", available: "1000", held: "0", consumed: "0",
        source: { kind: "redemption", sourceRef: committedFacts.grantSourceRef } });
      await expect(production.accountQueries.getCreditSummary({
        context: await commercePublicContext(fixture, "getCreditSummary"),
      })).resolves.toMatchObject({ activeHoldCount: 0, units: [{ unit: "credit_minor", buckets: [{
        bucketClass: "permanent", available: "1000", held: "0", consumed: "0",
        issued: "1000", grantCount: 1,
      }] }] });
      await expect(production.accountQueries.listAccountProducts({
        context: await commercePublicContext(fixture, "listAccountProducts"),
      })).resolves.toMatchObject({ products: [{ productVersionRef: fixture.productVersionRef,
        kind: "credit_pack", state: "active", source: { kind: "redemption" },
        creditGrantRefs: [grantId] }] });

      const fulfillmentReplay = await claimFulfillmentReplay(
        api,
        await commercePublicContext(fixture, "confirmRedemption"),
        confirmation.redemption.fulfillmentRef,
      );
      expect(fulfillmentReplay).toEqual({ disposition: "replay", receipt: {
        fulfillmentId: confirmation.redemption.fulfillmentRef,
        transactionVersion: 1,
        transactionDigest: committedFacts.fulfillmentTransactionDigest,
        outputSetDigest: committedFacts.fulfillmentOutputSetDigest,
        outputs: [{ kind: "credit_grant", outputLineId: "credits", outputOrdinal: 1,
          occurrence: 1, resourceRef: grantId,
          templateRevisionRef: grantOutput.templateRevisionRef,
          outputVersion: 1, outputDigest: committedFacts.fulfillmentOutputDigest }],
      } });
      expect(committedFacts.fulfillmentOutputSetDigest).toBe(confirmation.redemption.outputSetDigest);
      await expect(readFacts(bootstrap, fixture.siteId)).resolves.toEqual(committedFacts);

      const failureCode = required(fixture.rawCodes[1], "COMMERCE_COMPONENT_FAILURE_CODE_REQUIRED");
      const failurePreviewCommandId = commandId(); fixture.commandIds.push(failurePreviewCommandId);
      const failurePreview = await production.preview.execute({
        context: await commercePublicContext(fixture, "previewRedemption"),
        commandId: failurePreviewCommandId,
        idempotencyKey: `preview:${failurePreviewCommandId}`,
        code: failureCode,
      });
      const failureCommandId = commandId(); fixture.commandIds.push(failureCommandId);
      const failingProduction = createCommercePublicApplicationComposition({
        database: api,
        secrets,
        redemptionReference: () => "invalid-component-reference",
      });
      await expect(failingProduction.confirm.execute({
        context: await commercePublicContext(fixture, "confirmRedemption"),
        commandId: failureCommandId,
        idempotencyKey: `confirm:${failureCommandId}`,
        previewCredential: failurePreview.preview.previewCredential,
        legalAcceptanceRefs: [],
      })).rejects.toBeDefined();
      const rollback = await bootstrap.query<{
        preview_state: string;
        code_state: string;
        failure_receipt_count: number;
      }>(
        `SELECT preview.state AS preview_state,code.state AS code_state,
                (SELECT count(*)::int FROM platform.command_receipt WHERE command_id=$3)
                  AS failure_receipt_count
         FROM platform.commerce_redemption_preview preview
         JOIN platform.commerce_redeem_code code
           ON code.code_ref=preview.code_ref AND code.site_ref=preview.site_ref
         WHERE preview.preview_ref=$1::uuid AND preview.site_ref=$2`,
        [failurePreview.preview.previewRef, fixture.siteId, failureCommandId],
      );
      expect(rollback.rows).toEqual([
        { preview_state: "live", code_state: "available", failure_receipt_count: 0 },
      ]);
      expect(await readFacts(bootstrap, fixture.siteId)).toEqual({
        ...committedFacts,
        previewCount: 2,
      });
      await bootstrap.query(
        `UPDATE platform.commerce_redemption
         SET state='reversed',state_observed_at=clock_timestamp()
         WHERE redemption_id=$1::uuid AND site_ref=$2`,
        [confirmation.redemption.redemptionId, fixture.siteId],
      );
      await expect(production.accountQueries.listAccountProducts({
        context: await commercePublicContext(fixture, "listAccountProducts"),
      })).resolves.toMatchObject({ products: [{
        productVersionRef: fixture.productVersionRef,
        kind: "credit_pack",
        state: "revoked",
        source: { kind: "redemption" },
      }] });
    } finally {
      await Promise.allSettled([wrongRole.end(), admin.disconnect(), api.disconnect()]);
      try {
        if (fixture !== undefined) await cleanupCommerceRedemptionFixture(bootstrap, fixture);
      } finally {
        await Promise.allSettled([bootstrap.end(), fixture?.removeSecrets()]);
      }
    }
  }, 120_000);

  it("serializes a max-one account so two concurrent confirmations cannot both fulfill", async () => {
    await runPlatformMigrations({ environment: { ...process.env,
      DATABASE_URL_PLATFORM: migratorUrl, PLATFORM_DATABASE_CREDENTIAL_CLASS: "migrator" } });
    const bootstrap = new Client({ connectionString: bootstrapUrl });
    const admin = createPlatformDatabaseClient(loadPlatformDatabaseConfig("admin", {
      DATABASE_URL_PLATFORM: adminUrl,
      PLATFORM_DATABASE_CREDENTIAL_CLASS: "admin",
      PLATFORM_DATABASE_ADMIN_ROLE: adminRole,
      PLATFORM_DATABASE_MIGRATOR_ROLE: migratorRole,
      PLATFORM_DATABASE_EXPECTED_DATABASE: databaseName,
    }));
    const api = createPlatformDatabaseClient(loadPlatformDatabaseConfig("api", {
      DATABASE_URL_PLATFORM: apiUrl,
      PLATFORM_DATABASE_CREDENTIAL_CLASS: "api",
      PLATFORM_DATABASE_API_ROLE: apiRole,
      PLATFORM_DATABASE_MIGRATOR_ROLE: migratorRole,
      PLATFORM_DATABASE_EXPECTED_DATABASE: databaseName,
    }));
    let fixture: CommerceRedemptionFixture | undefined;
    await Promise.all([bootstrap.connect(), admin.connect(), api.connect()]);
    try {
      fixture = await provisionCommerceRedemptionFixture({
        bootstrap,
        admin,
        maxRedemptionsPerAccount: 1,
      });
      const secrets = await loadRedemptionSecretCodec(fixture.secretsPath);
      const production = createCommercePublicApplicationComposition({ database: api, secrets });
      const previews = [];
      for (const rawCode of fixture.rawCodes) {
        const previewCommandId = commandId(); fixture.commandIds.push(previewCommandId);
        previews.push(await production.preview.execute({
          context: await commercePublicContext(fixture, "previewRedemption"),
          commandId: previewCommandId,
          idempotencyKey: `preview:${previewCommandId}`,
          code: rawCode,
        }));
      }

      const confirmations = previews.map(async (preview) => {
        const confirmationCommandId = commandId(); fixture!.commandIds.push(confirmationCommandId);
        const input = Object.freeze({
          context: await commercePublicContext(fixture!, "confirmRedemption"),
          commandId: confirmationCommandId,
          idempotencyKey: `confirm:${confirmationCommandId}`,
          previewCredential: preview.preview.previewCredential,
          legalAcceptanceRefs: Object.freeze([]),
        });
        return Object.freeze({ input, result: production.confirm.execute(input) });
      });
      const pending = await Promise.all(confirmations);
      const results = await Promise.all(pending.map(async ({ input, result }) =>
        Object.freeze({ input, result: await result })));
      const succeeded = results.filter(({ result }) => result.kind === "succeeded");
      const rejected = results.filter(({ result }) => result.kind === "rejected");
      expect(succeeded).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.result).toMatchObject({
        kind: "rejected",
        rejection: { code: "REDEEM_NOT_ACCEPTED", retryClass: "never", retryAfter: null },
      });
      for (const terminal of results) {
        await expect(production.confirm.execute(terminal.input)).resolves.toEqual(terminal.result);
      }
      await expect(readConcurrentLimitFacts(bootstrap, fixture.siteId)).resolves.toEqual({
        livePreviewCount: 1,
        consumedPreviewCount: 1,
        availableCodeCount: 1,
        claimedCodeCount: 1,
        redemptionCount: 1,
        fulfillmentCount: 1,
        creditGrantCount: 1,
        grantJournalCount: 1,
        grantJournalEntryCount: 2,
        availableBalance: "1000",
      });
    } finally {
      await Promise.allSettled([admin.disconnect(), api.disconnect()]);
      try {
        if (fixture !== undefined) await cleanupCommerceRedemptionFixture(bootstrap, fixture);
      } finally {
        await Promise.allSettled([bootstrap.end(), fixture?.removeSecrets()]);
      }
    }
  }, 120_000);
});

type FulfillmentReplayRow = Readonly<{
  fulfillmentId: string;
  commandId: string | null;
  billingAccountId: string;
  siteId: string;
  sourceType: "redemption" | "payment" | "admin_grant" | "program_window";
  sourceRef: string;
  purpose: string;
  cycleKey: string;
  idempotencyKey: string;
  sourceVersion: bigint | string;
  sourceDigest: string;
  acquiredAt: Date | string;
  productVersionRef: string;
  planVersionRef: string | null;
  offeringVersionRef: string;
  fulfillmentProgramRevisionRef: string;
  fulfillmentProgramRevision: bigint | string;
  fulfillmentProgramDigest: string;
  pricingSnapshotRef: string | null;
}>;

async function claimFulfillmentReplay(
  database: PlatformTransactionalDatabaseClient,
  context: VerifiedRequestSecurityContext,
  fulfillmentId: string,
) {
  const unitOfWork = new PlatformUnitOfWork(database);
  const commerce = new PostgresCommerceRepository();
  return unitOfWork.execute({ context, operation: "confirmRedemption" }, async (transaction) => {
    const rows = await resolvePlatformTransaction(transaction).query<FulfillmentReplayRow>(
      `SELECT fulfillment_id::text AS "fulfillmentId",command_id AS "commandId",
              billing_account_ref AS "billingAccountId",site_ref AS "siteId",source_type AS "sourceType",
              source_id AS "sourceRef",purpose,cycle_key AS "cycleKey",idempotency_key AS "idempotencyKey",
              source_version AS "sourceVersion",source_digest AS "sourceDigest",acquired_at AS "acquiredAt",
              product_version_ref AS "productVersionRef",plan_version_ref AS "planVersionRef",
              offering_version_ref AS "offeringVersionRef",
              fulfillment_program_revision_ref AS "fulfillmentProgramRevisionRef",
              fulfillment_program_revision AS "fulfillmentProgramRevision",
              fulfillment_program_digest AS "fulfillmentProgramDigest",
              pricing_snapshot_ref AS "pricingSnapshotRef"
       FROM platform.commerce_fulfillment_transaction WHERE fulfillment_id=$1::uuid`,
      [fulfillmentId],
    );
    const row = required(rows[0], "COMMERCE_COMPONENT_FULFILLMENT_REQUIRED");
    const source = createFulfillmentSourceIdentity({ siteId: row.siteId, sourceType: row.sourceType,
      sourceRef: row.sourceRef, purpose: row.purpose, cycleKey: row.cycleKey });
    expect(source.idempotencyKey).toBe(row.idempotencyKey);
    const snapshot = createFrozenFulfillmentSnapshot({ sourceType: row.sourceType,
      sourceVersion: BigInt(row.sourceVersion), sourceDigest: row.sourceDigest,
      acquiredAt: new Date(row.acquiredAt).toISOString(), productVersionRef: row.productVersionRef,
      planVersionRef: row.planVersionRef, offeringVersionRef: row.offeringVersionRef,
      fulfillmentProgramRevisionRef: row.fulfillmentProgramRevisionRef,
      fulfillmentProgramRevision: BigInt(row.fulfillmentProgramRevision),
      fulfillmentProgramDigest: row.fulfillmentProgramDigest,
      pricingSnapshotRef: row.pricingSnapshotRef });
    return commerce.claimFulfillment(transaction, { fulfillmentId: row.fulfillmentId,
      commandId: row.commandId, billingAccountId: row.billingAccountId, source, snapshot });
  });
}

async function readFacts(bootstrap: Client, siteId: string) {
  const result = await bootstrap.query<{
    preview_count: number; claimed_code_count: number; redemption_count: number;
    fulfillment_count: number; fulfillment_plan_count: number; fulfillment_output_count: number;
    credit_account_count: number; credit_grant_count: number; grant_journal_count: number;
    grant_journal_entry_count: number; grant_journal_debit_count: number;
    grant_journal_credit_count: number; grant_journal_debit_total: string;
    grant_journal_credit_total: string; available_balance: string; outbox_count: number;
    command_outbox_count: number; audit_count: number; grant_source_type: string;
    grant_source_ref: string; fulfillment_transaction_digest: string;
    fulfillment_output_set_digest: string; fulfillment_output_digest: string;
  }>(
    `SELECT
       (SELECT count(*)::int FROM platform.commerce_redemption_preview WHERE site_ref=$1) preview_count,
       (SELECT count(*)::int FROM platform.commerce_redeem_code WHERE site_ref=$1 AND state='claimed') claimed_code_count,
       (SELECT count(*)::int FROM platform.commerce_redemption WHERE site_ref=$1) redemption_count,
       (SELECT count(*)::int FROM platform.commerce_fulfillment_transaction WHERE site_ref=$1) fulfillment_count,
       (SELECT count(*)::int FROM platform.commerce_fulfillment_output_plan plan
         JOIN platform.commerce_fulfillment_transaction tx ON tx.fulfillment_id=plan.fulfillment_id
         WHERE tx.site_ref=$1) fulfillment_plan_count,
       (SELECT count(*)::int FROM platform.commerce_fulfillment_actual_output actual
         JOIN platform.commerce_fulfillment_transaction tx ON tx.fulfillment_id=actual.fulfillment_id
         WHERE tx.site_ref=$1) fulfillment_output_count,
       (SELECT count(*)::int FROM platform.credit_account WHERE site_ref=$1) credit_account_count,
       (SELECT count(*)::int FROM platform.credit_grant WHERE site_ref=$1) credit_grant_count,
       (SELECT count(*)::int FROM platform.credit_journal_transaction
         WHERE site_ref=$1 AND operation_kind='grant_issue') grant_journal_count,
       (SELECT count(*)::int FROM platform.credit_journal_entry
         WHERE site_ref=$1 AND credit_grant_id IS NOT NULL) grant_journal_entry_count,
       (SELECT count(*)::int FROM platform.credit_journal_entry
         WHERE site_ref=$1 AND entry_side='debit' AND account_type='grant_issuance_source')
         grant_journal_debit_count,
       (SELECT count(*)::int FROM platform.credit_journal_entry
         WHERE site_ref=$1 AND entry_side='credit' AND account_type='customer_available')
         grant_journal_credit_count,
       (SELECT COALESCE(sum(amount) FILTER (WHERE entry_side='debit'),0)::text
         FROM platform.credit_journal_entry WHERE site_ref=$1) grant_journal_debit_total,
       (SELECT COALESCE(sum(amount) FILTER (WHERE entry_side='credit'),0)::text
         FROM platform.credit_journal_entry WHERE site_ref=$1) grant_journal_credit_total,
       (SELECT COALESCE(sum(CASE WHEN entry_side='credit' AND account_type='customer_available'
          THEN amount ELSE 0 END),0)::text FROM platform.credit_journal_entry WHERE site_ref=$1) available_balance,
       (SELECT count(*)::int FROM platform.outbox_event WHERE owner='commerce'
          AND correlation_id IN (SELECT command_id FROM platform.commerce_command WHERE site_ref=$1)) outbox_count,
       (SELECT count(*)::int FROM platform.commerce_command_outbox link
          JOIN platform.commerce_command command ON command.command_id=link.command_id
          WHERE command.site_ref=$1) command_outbox_count,
       (SELECT count(*)::int FROM platform.commerce_audit_entry
         WHERE site_ref=$1 AND event_type='commerce.redemption.fulfilled') audit_count,
       (SELECT source_type FROM platform.credit_grant WHERE site_ref=$1 LIMIT 1) grant_source_type,
       (SELECT source_ref FROM platform.credit_grant WHERE site_ref=$1 LIMIT 1) grant_source_ref,
       (SELECT transaction_digest FROM platform.commerce_fulfillment_transaction
         WHERE site_ref=$1 LIMIT 1) fulfillment_transaction_digest,
       (SELECT output_set_digest FROM platform.commerce_fulfillment_transaction
         WHERE site_ref=$1 LIMIT 1) fulfillment_output_set_digest,
       (SELECT actual.output_digest FROM platform.commerce_fulfillment_actual_output actual
         JOIN platform.commerce_fulfillment_transaction tx ON tx.fulfillment_id=actual.fulfillment_id
         WHERE tx.site_ref=$1 LIMIT 1) fulfillment_output_digest`,
    [siteId],
  );
  const row = required(result.rows[0], "COMMERCE_COMPONENT_FACTS_REQUIRED");
  return Object.freeze({ previewCount: row.preview_count, claimedCodeCount: row.claimed_code_count,
    redemptionCount: row.redemption_count, fulfillmentCount: row.fulfillment_count,
    fulfillmentPlanCount: row.fulfillment_plan_count, fulfillmentOutputCount: row.fulfillment_output_count,
    creditAccountCount: row.credit_account_count, creditGrantCount: row.credit_grant_count,
    grantJournalCount: row.grant_journal_count, grantJournalEntryCount: row.grant_journal_entry_count,
    grantJournalDebitCount: row.grant_journal_debit_count,
    grantJournalCreditCount: row.grant_journal_credit_count,
    grantJournalDebitTotal: row.grant_journal_debit_total,
    grantJournalCreditTotal: row.grant_journal_credit_total,
    availableBalance: row.available_balance, outboxCount: row.outbox_count,
    commandOutboxCount: row.command_outbox_count, auditCount: row.audit_count,
    grantSourceType: row.grant_source_type, grantSourceRef: row.grant_source_ref,
    fulfillmentTransactionDigest: row.fulfillment_transaction_digest,
    fulfillmentOutputSetDigest: row.fulfillment_output_set_digest,
    fulfillmentOutputDigest: row.fulfillment_output_digest });
}

async function readConcurrentLimitFacts(bootstrap: Client, siteId: string) {
  const result = await bootstrap.query<{
    live_preview_count: number;
    consumed_preview_count: number;
    available_code_count: number;
    claimed_code_count: number;
    redemption_count: number;
    fulfillment_count: number;
    credit_grant_count: number;
    grant_journal_count: number;
    grant_journal_entry_count: number;
    available_balance: string;
  }>(
    `SELECT
       (SELECT count(*)::int FROM platform.commerce_redemption_preview
         WHERE site_ref=$1 AND state='live') live_preview_count,
       (SELECT count(*)::int FROM platform.commerce_redemption_preview
         WHERE site_ref=$1 AND state='consumed') consumed_preview_count,
       (SELECT count(*)::int FROM platform.commerce_redeem_code
         WHERE site_ref=$1 AND state='available') available_code_count,
       (SELECT count(*)::int FROM platform.commerce_redeem_code
         WHERE site_ref=$1 AND state='claimed') claimed_code_count,
       (SELECT count(*)::int FROM platform.commerce_redemption WHERE site_ref=$1) redemption_count,
       (SELECT count(*)::int FROM platform.commerce_fulfillment_transaction
         WHERE site_ref=$1) fulfillment_count,
       (SELECT count(*)::int FROM platform.credit_grant WHERE site_ref=$1) credit_grant_count,
       (SELECT count(*)::int FROM platform.credit_journal_transaction
         WHERE site_ref=$1 AND operation_kind='grant_issue') grant_journal_count,
       (SELECT count(*)::int FROM platform.credit_journal_entry
         WHERE site_ref=$1 AND credit_grant_id IS NOT NULL) grant_journal_entry_count,
       (SELECT COALESCE(sum(CASE WHEN entry_side='credit' AND account_type='customer_available'
          THEN amount ELSE 0 END),0)::text FROM platform.credit_journal_entry
          WHERE site_ref=$1) available_balance`,
    [siteId],
  );
  const row = required(result.rows[0], "COMMERCE_COMPONENT_CONCURRENT_FACTS_REQUIRED");
  return Object.freeze({ livePreviewCount: row.live_preview_count,
    consumedPreviewCount: row.consumed_preview_count, availableCodeCount: row.available_code_count,
    claimedCodeCount: row.claimed_code_count, redemptionCount: row.redemption_count,
    fulfillmentCount: row.fulfillment_count, creditGrantCount: row.credit_grant_count,
    grantJournalCount: row.grant_journal_count, grantJournalEntryCount: row.grant_journal_entry_count,
    availableBalance: row.available_balance });
}

function commandId(): string { return randomUUID().replaceAll("-", ""); }
function required<Value>(value: Value | undefined, code: string): Value {
  if (value === undefined) throw new Error(code); return value;
}
function leased(value: string | undefined): string {
  if (value === undefined) throw new Error("PLATFORM_POSTGRES_LEASE_URL_REQUIRED");
  const url = new URL(value);
  if (!url.pathname.slice(1).startsWith("kokoro_test_")) throw new Error("DATABASE_URL_PLATFORM_TEST_MUST_BE_LEASED");
  return value;
}
function role(value: string | undefined): string {
  if (value === undefined || !/^[a-z_][a-z0-9_]{0,62}$/u.test(value)) {
    throw new Error("PLATFORM_POSTGRES_ROLE_REQUIRED");
  }
  return value;
}
