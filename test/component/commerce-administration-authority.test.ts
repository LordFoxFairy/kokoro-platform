import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import type { HandlerContext } from "@connectrpc/connect";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import {
  CommandDigestAlgorithmV2,
  CommandIdentityV2Schema,
  OperatorAssuranceLevel,
} from "../../src/generated/proto/kokoro/common/v2/command_envelope_pb.js";
import {
  AuthenticatedOperatorCommandContextSchema,
  AuthenticatedOperatorQueryContextSchema,
  OperatorScopeSchema,
  SecurityEpochsSchema,
  SiteScopeSchema,
  type AuthenticatedOperatorCommandContext,
} from "../../src/generated/proto/kokoro/platform/admin/v2/admin_shared_pb.js";
import {
  CommerceCommandDisposition,
  CommerceFulfillmentOutputKind,
  CommercePageRequestSchema,
  CommercePlanTermAction,
  CommerceProductKind,
  CommerceSiteCommandContextSchema,
  CommerceSiteQueryContextSchema,
  CreditProgramBucketClass,
  CreditProgramRolloverPolicy,
  GetCreditProgramRevisionRequestSchema,
  GetEntitlementTemplateRevisionRequestSchema,
  GetOfferRevisionRequestSchema,
  GetRedemptionProgramRevisionRequestSchema,
  ListCreditProgramRevisionsRequestSchema,
  ListEntitlementTemplateRevisionsRequestSchema,
  ListOfferRevisionsRequestSchema,
  ListRedemptionProgramRevisionsRequestSchema,
  PublishCreditProgramRevisionEffectSchema,
  PublishCreditProgramRevisionRequestSchema,
  PublishEntitlementTemplateRevisionEffectSchema,
  PublishEntitlementTemplateRevisionRequestSchema,
  PublishOfferRevisionEffectSchema,
  PublishOfferRevisionRequestSchema,
  PublishRedemptionProgramRevisionEffectSchema,
  PublishRedemptionProgramRevisionRequestSchema,
  type CommerceSiteCommandContext,
} from "../../src/generated/proto/kokoro/platform/commerce/v1/commerce_catalog_pb.js";
import {
  ActivateCodeBatchEffectSchema,
  ActivateCodeBatchRequestSchema,
  ApproveCodeBatchEffectSchema,
  ApproveCodeBatchRequestSchema,
  CodeBatchApprovalState,
  CodeBatchState,
  GetCodeBatchRequestSchema,
  IssueCodeBatchEffectSchema,
  IssueCodeBatchRequestSchema,
  ListCodeBatchesRequestSchema,
} from "../../src/generated/proto/kokoro/platform/commerce/v1/commerce_control_pb.js";
import {
  activateCodeBatchRequestDigest,
  approveCodeBatchRequestDigest,
  issueCodeBatchRequestDigest,
  publishCreditProgramRevisionRequestDigest,
  publishEntitlementTemplateRevisionRequestDigest,
  publishOfferRevisionRequestDigest,
  publishRedemptionProgramRevisionRequestDigest,
  type VerifiedCommerceSiteAxes,
} from "../../src/generated/contracts/platform-admin-commerce@v1/digest.js";
import {
  createPlatformDatabaseClient,
  loadPlatformDatabaseConfig,
} from "../../src/infrastructure/postgres/client.js";
import { runPlatformMigrations } from "../../src/infrastructure/postgres/migrator.js";
import { HmacAdminPageCursorCodec } from
  "../../src/modules/admin/infrastructure/security/admin-page-cursor.js";
import type { AdminQueryPermit } from
  "../../src/modules/admin/interfaces/connect/admin-query-service.js";
import {
  createAdminCommerceConnectService,
  type CommerceAdminCommandOperation,
} from "../../src/modules/commerce/interfaces/connect/admin-commerce-service.js";
import { createCommerceAdministrationComposition } from
  "../../src/process/commerce-admin-composition.js";
import { verifyRequestSecurityContext } from
  "../../src/shared/security-context/request-security-context.js";

const migratorUrl = leased(process.env.DATABASE_URL_PLATFORM_MIGRATOR_TEST);
const bootstrapUrl = leased(process.env.DATABASE_URL_PLATFORM_BOOTSTRAP_TEST);
const adminUrl = leased(process.env.DATABASE_URL_PLATFORM_ADMIN_TEST);
const adminRole = role(process.env.PLATFORM_DATABASE_ADMIN_ROLE);
const migratorRole = role(process.env.PLATFORM_DATABASE_MIGRATOR_ROLE);
const databaseName = new URL(migratorUrl).pathname.slice(1);
const transport = {} as HandlerContext;
const environment = "production";
const region = "us-east-1";
const audience = "platform-admin";
const workloadIdentityRef = "spiffe://kokoro.test/admin/commerce-component";

describe("AdminCommerce PostgreSQL authority", () => {
  it("executes the production Site-scoped provider with frozen cursors and one-time code delivery", async () => {
    await runPlatformMigrations({ environment: { ...process.env,
      DATABASE_URL_PLATFORM: migratorUrl, PLATFORM_DATABASE_CREDENTIAL_CLASS: "migrator" } });
    const suffix = randomUUID().replaceAll("-", "");
    const siteId = `site:commerce:${suffix}`;
    const foreignSiteId = `site:commerce:foreign:${suffix}`;
    const maker = operator(`operator:commerce:maker:${suffix}`, 11n);
    const checker = operator(`operator:commerce:checker:${suffix}`, 7n);
    const timing = requestTiming();
    const references = Object.freeze({
      creditProgramRevisionRef: `credit-program-revision:${suffix}`,
      entitlementTemplateRevisionRef: `entitlement-template-revision:${suffix}`,
      planVersionRef: `plan-version:${suffix}`,
      productVersionRef: `offer:${suffix}:a`,
      secondProductVersionRef: `offer:${suffix}:b`,
      fulfillmentProgramRevisionRef: `fulfillment-program:${suffix}:a`,
      secondFulfillmentProgramRevisionRef: `fulfillment-program:${suffix}:b`,
      redemptionProgramRevisionRef: `redemption-program-revision:${suffix}`,
      batchRef: randomUUID(),
    });
    const commandIds: string[] = [];
    const bootstrap = new Client({ connectionString: bootstrapUrl });
    const admin = createPlatformDatabaseClient(loadPlatformDatabaseConfig("admin", {
      DATABASE_URL_PLATFORM: adminUrl,
      PLATFORM_DATABASE_CREDENTIAL_CLASS: "admin",
      PLATFORM_DATABASE_ADMIN_ROLE: adminRole,
      PLATFORM_DATABASE_MIGRATOR_ROLE: migratorRole,
      PLATFORM_DATABASE_EXPECTED_DATABASE: databaseName,
    }));
    const secrets = await keyRing();
    await Promise.all([bootstrap.connect(), admin.connect()]);
    try {
      await bootstrap.query(
        `INSERT INTO platform.authorization_site
         (site_ref,state,security_epoch,policy_epoch,revocation_epoch)
         VALUES ($1,'active',1,1,1),($2,'active',1,1,1)`,
        [siteId, foreignSiteId],
      );
      const production = await createCommerceAdministrationComposition({
        database: admin,
        environment: { PLATFORM_COMMERCE_REDEMPTION_KEY_RING_FILE: secrets.path },
      });
      const authority = componentResolver(timing, siteId);
      const provider = createAdminCommerceConnectService({
        owner: production.commerce,
        reader: production.reader,
        resolver: authority.resolver,
        cursors: new HmacAdminPageCursorCodec(Buffer.alloc(32, 19)),
      });

      const creditEffect = create(PublishCreditProgramRevisionEffectSchema, {
        creditProgramRevisionRef: references.creditProgramRevisionRef,
        programRef: `credit-program:${suffix}`,
        revision: 1n,
        uxBucketClass: CreditProgramBucketClass.PERIOD,
        unit: "credit_minor",
        amount: "250",
        burnPriority: 20,
        scopePolicy: { policyVersion: 1, surfaceRefs: ["chat"],
          capabilityKeys: ["chat.generate"], agentRefs: [], allowUnattributedAgent: true },
        liabilityMerchantAccountRef: "merchant:platform",
        rolloverPolicy: CreditProgramRolloverPolicy.NONE,
        calendarZone: "UTC",
        windowAnchor: "subscription-term-start",
        expiresAfterSeconds: 2_592_000n,
      });
      const credit = signedCommand(siteId, maker, timing, commandIds);
      setDigest(credit.context, publishCreditProgramRevisionRequestDigest(
        credit.context, creditEffect, credit.axes,
      ));
      const publishedCredit = await provider.publishCreditProgramRevision(
        create(PublishCreditProgramRevisionRequestSchema, { context: credit.context, effect: creditEffect }),
        transport,
      );
      expect(publishedCredit).toMatchObject({ disposition: CommerceCommandDisposition.COMMITTED,
        result: { creditProgramRevisionRef: references.creditProgramRevisionRef } });

      const entitlementEffect = create(PublishEntitlementTemplateRevisionEffectSchema, {
        entitlementTemplateRevisionRef: references.entitlementTemplateRevisionRef,
        templateRef: `entitlement-template:${suffix}`,
        revision: 1n,
        capabilityKey: "chat.generate",
        safeLabel: "Component chat entitlement",
        expiresAfterSeconds: 2_592_000n,
      });
      const entitlement = signedCommand(siteId, maker, timing, commandIds);
      setDigest(entitlement.context, publishEntitlementTemplateRevisionRequestDigest(
        entitlement.context, entitlementEffect, entitlement.axes,
      ));
      await expect(provider.publishEntitlementTemplateRevision(
        create(PublishEntitlementTemplateRevisionRequestSchema, {
          context: entitlement.context, effect: entitlementEffect,
        }), transport,
      )).resolves.toMatchObject({ disposition: CommerceCommandDisposition.COMMITTED });

      const offerEffect = create(PublishOfferRevisionEffectSchema, {
        productRef: `product:${suffix}:subscription`,
        productKind: CommerceProductKind.SUBSCRIPTION,
        productVersionRef: references.productVersionRef,
        productRevision: 1n,
        safeLabel: "Component subscription",
        planVersion: { planRef: `plan:${suffix}`, planVersionRef: references.planVersionRef,
          revision: 1n, safeLabel: "Monthly component plan",
          termAction: CommercePlanTermAction.NEW_SUBSCRIPTION, termSeconds: 2_592_000n,
          stackingScope: "billing-account" },
        fulfillmentProgramRevisionRef: references.fulfillmentProgramRevisionRef,
        fulfillmentProgramRef: `fulfillment:${suffix}:a`,
        fulfillmentProgramRevision: 1n,
        outputs: [
          { outputLineId: "subscription", ordinal: 1, cardinality: 1,
            outputKind: CommerceFulfillmentOutputKind.SUBSCRIPTION_TERM,
            targetRevisionRef: references.planVersionRef },
          { outputLineId: "entitlement", ordinal: 2, cardinality: 1,
            outputKind: CommerceFulfillmentOutputKind.ENTITLEMENT_GRANT,
            targetRevisionRef: references.entitlementTemplateRevisionRef },
          { outputLineId: "period-credits", ordinal: 3, cardinality: 1,
            outputKind: CommerceFulfillmentOutputKind.CREDIT_PROGRAM_ENROLLMENT,
            targetRevisionRef: references.creditProgramRevisionRef },
        ],
        legalTermRefs: [`legal:${suffix}`],
      });
      const offer = signedCommand(siteId, maker, timing, commandIds);
      setDigest(offer.context, publishOfferRevisionRequestDigest(offer.context, offerEffect, offer.axes));
      await expect(provider.publishOfferRevision(create(PublishOfferRevisionRequestSchema, {
        context: offer.context, effect: offerEffect,
      }), transport)).resolves.toMatchObject({ disposition: CommerceCommandDisposition.COMMITTED });

      const secondOfferEffect = create(PublishOfferRevisionEffectSchema, {
        productRef: `product:${suffix}:free`, productKind: CommerceProductKind.FREE,
        productVersionRef: references.secondProductVersionRef, productRevision: 1n,
        safeLabel: "Component free entitlement",
        fulfillmentProgramRevisionRef: references.secondFulfillmentProgramRevisionRef,
        fulfillmentProgramRef: `fulfillment:${suffix}:b`, fulfillmentProgramRevision: 1n,
        outputs: [{ outputLineId: "entitlement", ordinal: 1, cardinality: 1,
          outputKind: CommerceFulfillmentOutputKind.ENTITLEMENT_GRANT,
          targetRevisionRef: references.entitlementTemplateRevisionRef }],
        legalTermRefs: [],
      });
      const secondOffer = signedCommand(siteId, maker, timing, commandIds);
      setDigest(secondOffer.context, publishOfferRevisionRequestDigest(
        secondOffer.context, secondOfferEffect, secondOffer.axes,
      ));
      await provider.publishOfferRevision(create(PublishOfferRevisionRequestSchema, {
        context: secondOffer.context, effect: secondOfferEffect,
      }), transport);

      const redemptionEffect = create(PublishRedemptionProgramRevisionEffectSchema, {
        redemptionProgramRevisionRef: references.redemptionProgramRevisionRef,
        programRef: `redemption-program:${suffix}`, revision: 1n,
        productVersionRef: references.productVersionRef,
        fulfillmentProgramRevisionRef: references.fulfillmentProgramRevisionRef,
        maxRedemptionsPerAccount: 1,
      });
      const redemption = signedCommand(siteId, maker, timing, commandIds);
      setDigest(redemption.context, publishRedemptionProgramRevisionRequestDigest(
        redemption.context, redemptionEffect, redemption.axes,
      ));
      await expect(provider.publishRedemptionProgramRevision(
        create(PublishRedemptionProgramRevisionRequestSchema, {
          context: redemption.context, effect: redemptionEffect,
        }), transport,
      )).resolves.toMatchObject({ disposition: CommerceCommandDisposition.COMMITTED });

      const issueEffect = create(IssueCodeBatchEffectSchema, {
        batchRef: references.batchRef,
        redemptionProgramRevisionRef: references.redemptionProgramRevisionRef,
        count: 2,
      });
      const issue = signedCommand(siteId, maker, timing, commandIds);
      setDigest(issue.context, issueCodeBatchRequestDigest(issue.context, issueEffect, issue.axes));
      const issueRequest = create(IssueCodeBatchRequestSchema, { context: issue.context, effect: issueEffect });
      const firstDelivery = await provider.issueCodeBatch(issueRequest, transport);
      expect(firstDelivery.disposition).toBe(CommerceCommandDisposition.COMMITTED);
      expect(firstDelivery.delivery?.case).toBe("secretExport");
      const rawCodes = firstDelivery.delivery?.case === "secretExport"
        ? [...(firstDelivery.delivery.value.rawCodes ?? [])] : [];
      expect(rawCodes).toHaveLength(2);
      const replay = await provider.issueCodeBatch(issueRequest, transport);
      expect(replay.disposition).toBe(CommerceCommandDisposition.REPLAYED);
      expect(replay.delivery?.case).toBe("deliveryUnavailable");
      expect(replay.delivery?.case).not.toBe("secretExport");

      const makerApprovalEffect = create(ApproveCodeBatchEffectSchema, { batchRef: references.batchRef });
      const makerApproval = signedCommand(siteId, maker, timing, commandIds);
      setDigest(makerApproval.context, approveCodeBatchRequestDigest(
        makerApproval.context, makerApprovalEffect, makerApproval.axes,
      ));
      await expect(provider.approveCodeBatch(create(ApproveCodeBatchRequestSchema, {
        context: makerApproval.context, effect: makerApprovalEffect,
      }), transport)).rejects.toThrow("COMMERCE_BATCH_MAKER_CHECKER_REQUIRED");

      const approval = signedCommand(siteId, checker, timing, commandIds);
      setDigest(approval.context, approveCodeBatchRequestDigest(
        approval.context, makerApprovalEffect, approval.axes,
      ));
      const approved = await provider.approveCodeBatch(create(ApproveCodeBatchRequestSchema, {
        context: approval.context, effect: makerApprovalEffect,
      }), transport);
      expect(approved.result).toMatchObject({ state: CodeBatchState.DRAFT,
        approvalState: CodeBatchApprovalState.APPROVED });

      const activateEffect = create(ActivateCodeBatchEffectSchema, { batchRef: references.batchRef });
      const activation = signedCommand(siteId, checker, timing, commandIds);
      setDigest(activation.context, activateCodeBatchRequestDigest(
        activation.context, activateEffect, activation.axes,
      ));
      const activated = await provider.activateCodeBatch(create(ActivateCodeBatchRequestSchema, {
        context: activation.context, effect: activateEffect,
      }), transport);
      expect(activated.result).toMatchObject({ state: CodeBatchState.ACTIVE,
        approvalState: CodeBatchApprovalState.APPROVED });

      const query = queryContext(siteId, maker, timing);
      const page = create(CommercePageRequestSchema, { pageSize: 10 });
      const creditList = await provider.listCreditProgramRevisions(
        create(ListCreditProgramRevisionsRequestSchema, { context: query, page }), transport,
      );
      expect((creditList.items ?? []).map((item) => item.creditProgramRevisionRef))
        .toContain(references.creditProgramRevisionRef);
      await expect(provider.getCreditProgramRevision(create(GetCreditProgramRevisionRequestSchema, {
        context: query, creditProgramRevisionRef: references.creditProgramRevisionRef,
      }), transport)).resolves.toMatchObject({ revision: { windowKind: 3 } });

      const entitlementList = await provider.listEntitlementTemplateRevisions(
        create(ListEntitlementTemplateRevisionsRequestSchema, { context: query, page }), transport,
      );
      expect((entitlementList.items ?? []).map((item) => item.entitlementTemplateRevisionRef))
        .toContain(references.entitlementTemplateRevisionRef);
      await expect(provider.getEntitlementTemplateRevision(
        create(GetEntitlementTemplateRevisionRequestSchema, { context: query,
          entitlementTemplateRevisionRef: references.entitlementTemplateRevisionRef }), transport,
      )).resolves.toMatchObject({ revision: { capabilityKey: "chat.generate" } });

      const firstOfferPage = await provider.listOfferRevisions(create(ListOfferRevisionsRequestSchema, {
        context: query, page: create(CommercePageRequestSchema, { pageSize: 1 }),
      }), transport);
      expect(firstOfferPage.items).toHaveLength(1);
      expect(firstOfferPage.nextPageToken).toBeTypeOf("string");
      const offerView = await provider.getOfferRevision(create(GetOfferRevisionRequestSchema, {
        context: query, productVersionRef: references.productVersionRef,
      }), transport);
      const detailedOffer = required(offerView.revision, "COMMERCE_COMPONENT_OFFER_REQUIRED");
      expect(detailedOffer.planVersion?.planVersionRef).toBe(references.planVersionRef);
      expect((detailedOffer.outputs ?? []).map((output) => output.outputKind))
        .toContain(CommerceFulfillmentOutputKind.CREDIT_PROGRAM_ENROLLMENT);
      const continuedOfferPage = await provider.listOfferRevisions(create(ListOfferRevisionsRequestSchema, {
        context: query, page: create(CommercePageRequestSchema, {
          pageSize: 1, pageToken: firstOfferPage.nextPageToken,
        }),
      }), transport);
      expect(continuedOfferPage.observedAt).toEqual(firstOfferPage.observedAt);
      expect(continuedOfferPage.items?.[0]?.productVersionRef).toBe(references.secondProductVersionRef);

      const redemptionList = await provider.listRedemptionProgramRevisions(
        create(ListRedemptionProgramRevisionsRequestSchema, { context: query, page }), transport,
      );
      expect((redemptionList.items ?? []).map((item) => item.redemptionProgramRevisionRef))
        .toContain(references.redemptionProgramRevisionRef);
      await expect(provider.getRedemptionProgramRevision(
        create(GetRedemptionProgramRevisionRequestSchema, { context: query,
          redemptionProgramRevisionRef: references.redemptionProgramRevisionRef }), transport,
      )).resolves.toMatchObject({ revision: { availabilityState: 1 } });

      const batches = await provider.listCodeBatches(
        create(ListCodeBatchesRequestSchema, { context: query, page }), transport,
      );
      expect(batches.items).toHaveLength(1);
      expect(batches.items?.[0]).not.toHaveProperty("rawCodes");
      const batch = await provider.getCodeBatch(create(GetCodeBatchRequestSchema, {
        context: query, batchRef: references.batchRef,
      }), transport);
      expect(batch.batch).toMatchObject({ state: CodeBatchState.ACTIVE,
        approvalState: CodeBatchApprovalState.APPROVED, inventoryCount: 2 });
      expect(batch.batch).not.toHaveProperty("rawCodes");

      const token = firstOfferPage.nextPageToken!;
      const tampered = `${token[0] === "A" ? "B" : "A"}${token.slice(1)}`;
      await expect(provider.listOfferRevisions(create(ListOfferRevisionsRequestSchema, {
        context: query, page: create(CommercePageRequestSchema, { pageSize: 1, pageToken: tampered }),
      }), transport)).rejects.toThrow("ADMIN_PAGE_TOKEN_INVALID");
      await expect(provider.listRedemptionProgramRevisions(
        create(ListRedemptionProgramRevisionsRequestSchema, { context: query,
          page: create(CommercePageRequestSchema, { pageSize: 1, pageToken: token }) }), transport,
      )).rejects.toThrow("COMMERCE_ADMIN_PAGE_TOKEN_INVALID");
      await expect(provider.listOfferRevisions(create(ListOfferRevisionsRequestSchema, {
        context: queryContext(foreignSiteId, maker, timing),
        page: create(CommercePageRequestSchema, { pageSize: 1, pageToken: token }),
      }), transport)).rejects.toThrow("COMMERCE_ADMIN_PAGE_TOKEN_INVALID");
      authority.setBinding("b");
      await expect(provider.listOfferRevisions(create(ListOfferRevisionsRequestSchema, {
        context: query, page: create(CommercePageRequestSchema, { pageSize: 1, pageToken: token }),
      }), transport)).rejects.toThrow("COMMERCE_ADMIN_PAGE_TOKEN_INVALID");
      authority.setBinding("a");
      authority.setScopeSite(foreignSiteId);
      await expect(provider.getCreditProgramRevision(create(GetCreditProgramRevisionRequestSchema, {
        context: query, creditProgramRevisionRef: references.creditProgramRevisionRef,
      }), transport)).rejects.toThrow("ADMIN_SITE_SCOPE_DENIED");
      authority.setScopeSite(null);
      await expect(provider.getCreditProgramRevision(create(GetCreditProgramRevisionRequestSchema, {
        context: queryContext(foreignSiteId, maker, timing),
        creditProgramRevisionRef: references.creditProgramRevisionRef,
      }), transport)).rejects.toThrow("COMMERCE_ADMIN_CREDIT_PROGRAM_NOT_FOUND");

      const persisted = await bootstrap.query<{
        receipt_result: string; export_digest: string; fingerprints: string[]; raw_column_count: number;
      }>(
        `SELECT
           (SELECT result::text FROM platform.command_receipt WHERE command_id=$1) AS receipt_result,
           (SELECT export_digest FROM platform.commerce_code_secret_export
             WHERE site_ref=$2 AND batch_ref=$3::uuid) AS export_digest,
           (SELECT array_agg(safe_fingerprint ORDER BY safe_fingerprint)
             FROM platform.commerce_redeem_code WHERE site_ref=$2 AND batch_ref=$3::uuid) AS fingerprints,
           (SELECT count(*)::int FROM information_schema.columns
             WHERE table_schema='platform' AND table_name IN
               ('commerce_code_batch','commerce_code_secret_export','commerce_redeem_code')
               AND column_name ~ '(raw|plain).*code') AS raw_column_count`,
        [issue.context.operator!.command!.commandId, siteId, references.batchRef],
      );
      expect(persisted.rows[0]?.raw_column_count).toBe(0);
      expect(persisted.rows[0]?.export_digest).toMatch(/^[a-f0-9]{64}$/u);
      expect(persisted.rows[0]?.fingerprints).toHaveLength(2);
      for (const rawCode of rawCodes) {
        expect(persisted.rows[0]?.receipt_result).not.toContain(rawCode);
        expect(persisted.rows[0]?.export_digest).not.toContain(rawCode);
        expect(persisted.rows[0]?.fingerprints.join("\n")).not.toContain(rawCode);
      }
    } finally {
      await Promise.allSettled([admin.disconnect()]);
      try {
        await cleanup(bootstrap, siteId, foreignSiteId, commandIds);
      } finally {
        await Promise.allSettled([bootstrap.end(), secrets.remove()]);
      }
    }
  }, 120_000);
});

type OperatorFixture = Readonly<{ actorRef: string; generation: bigint; sessionRef: string;
  managedDeviceRef: string; attestationRef: string; attestationDigest: string }>;
type Timing = Readonly<{ now: string; issuedAt: string; expiresAt: string;
  authenticatedAt: ReturnType<typeof timestampFromDate>; stepUpAt: ReturnType<typeof timestampFromDate> }>;

function operator(actorRef: string, generation: bigint): OperatorFixture {
  return Object.freeze({ actorRef, generation, sessionRef: `session:${randomUUID()}`,
    managedDeviceRef: `device:${randomUUID()}`, attestationRef: `attestation:${randomUUID()}`,
    attestationDigest: "d".repeat(64) });
}

function requestTiming(): Timing {
  const now = new Date();
  const issuedAt = new Date(now.getTime() - 60_000);
  const stepUpAt = new Date(now.getTime() - 30_000);
  return Object.freeze({ now: now.toISOString(), issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(now.getTime() + 600_000).toISOString(),
    authenticatedAt: timestampFromDate(issuedAt), stepUpAt: timestampFromDate(stepUpAt) });
}

function signedCommand(
  siteId: string,
  actor: OperatorFixture,
  timing: Timing,
  commandIds: string[],
): Readonly<{ context: CommerceSiteCommandContext; axes: VerifiedCommerceSiteAxes }> {
  const commandId = randomUUID(); commandIds.push(commandId);
  const context = create(CommerceSiteCommandContextSchema, { siteId,
    operator: create(AuthenticatedOperatorCommandContextSchema, {
      command: create(CommandIdentityV2Schema, { commandId,
        idempotencyKey: `commerce-component-${commandId}`,
        digestAlgorithm: CommandDigestAlgorithmV2.SHA256_COMMAND_ENVELOPE,
        requestDigest: "0".repeat(64) }),
      actorRef: actor.actorRef, operatorGeneration: actor.generation,
      operatorSessionRef: actor.sessionRef, environment, region,
      managedDeviceRef: actor.managedDeviceRef,
      assuranceLevel: OperatorAssuranceLevel.PHISHING_RESISTANT,
      factorClasses: ["oidc", "webauthn"], authenticatedAt: timing.authenticatedAt,
      stepUpAt: timing.stepUpAt, operatorAttestationRef: actor.attestationRef,
      operatorAttestationDigest: actor.attestationDigest,
      securityEpochs: create(SecurityEpochsSchema, { operatorSecurityEpoch: 2n,
        sessionEpoch: 3n, restrictionEpoch: 4n, policyEpoch: 5n, siteSecurityEpoch: 6n }),
      scope: siteScope(siteId),
    }) });
  return Object.freeze({ context, axes: axes(context.operator!, siteId) });
}

function setDigest(context: CommerceSiteCommandContext, digest: string): void {
  context.operator!.command!.requestDigest = digest;
}

function axes(claimed: AuthenticatedOperatorCommandContext, siteId: string): VerifiedCommerceSiteAxes {
  return Object.freeze({ siteId, workloadIdentityRef, audience, actorRef: claimed.actorRef,
    operatorGeneration: claimed.operatorGeneration, operatorSessionRef: claimed.operatorSessionRef,
    environment: claimed.environment, region: claimed.region, managedDeviceRef: claimed.managedDeviceRef,
    assuranceLevel: claimed.assuranceLevel, factorClasses: Object.freeze([...claimed.factorClasses]),
    authenticatedAt: claimed.authenticatedAt!, ...(claimed.stepUpAt === undefined ? {} : {
      stepUpAt: claimed.stepUpAt,
    }), operatorAttestationRef: claimed.operatorAttestationRef,
    operatorAttestationDigest: claimed.operatorAttestationDigest });
}

function queryContext(siteId: string, actor: OperatorFixture, timing: Timing) {
  return create(CommerceSiteQueryContextSchema, { siteId,
    operator: create(AuthenticatedOperatorQueryContextSchema, {
      requestId: `request:${randomUUID()}`, actorRef: actor.actorRef,
      operatorGeneration: actor.generation, operatorSessionRef: actor.sessionRef,
      environment, region, managedDeviceRef: actor.managedDeviceRef,
      assuranceLevel: OperatorAssuranceLevel.PHISHING_RESISTANT,
      factorClasses: ["oidc", "webauthn"], authenticatedAt: timing.authenticatedAt,
      stepUpAt: timing.stepUpAt, operatorAttestationRef: actor.attestationRef,
      operatorAttestationDigest: actor.attestationDigest,
      securityEpochs: create(SecurityEpochsSchema, { operatorSecurityEpoch: 2n,
        sessionEpoch: 3n, restrictionEpoch: 4n, policyEpoch: 5n, siteSecurityEpoch: 6n }),
      scope: siteScope(siteId),
    }) });
}

function siteScope(siteId: string) {
  return create(OperatorScopeSchema, { kind: { case: "site", value: create(SiteScopeSchema, {
    siteIds: [siteId], environment, region,
  }) } });
}

function componentResolver(timing: Timing, defaultSiteId: string) {
  let binding = "a";
  let scopeSite: string | null = null;
  return Object.freeze({
    setBinding(value: string) { binding = value; },
    setScopeSite(value: string | null) { scopeSite = value; },
    resolver: Object.freeze({
      async resolveCommerceCommand(
        claimed: AuthenticatedOperatorCommandContext,
        _transport: HandlerContext,
        request: Readonly<{ operation: CommerceAdminCommandOperation; siteRef: string }>,
      ) {
        return Object.freeze({ axes: axes(claimed, request.siteRef),
          context: await verifiedContext(timing, claimed, request.operation, request.siteRef) });
      },
      async resolve(
        claimed: Readonly<{ actorRef: string }>,
        _transport: HandlerContext,
        request: Readonly<{ operation: AdminQueryPermit["operation"]; siteRef: string | null }>,
      ): Promise<AdminQueryPermit> {
        const siteId = request.siteRef ?? defaultSiteId;
        return Object.freeze({ operatorRef: claimed.actorRef, environment, region,
          operation: request.operation, authorityBindingDigest: binding.repeat(64),
          scope: { kind: "site" as const, siteRefs: Object.freeze([scopeSite ?? siteId]) } });
      },
    }),
  });
}

async function verifiedContext(
  timing: Timing,
  claimed: AuthenticatedOperatorCommandContext,
  operation: CommerceAdminCommandOperation,
  siteId: string,
) {
  const issuer = "spiffe://kokoro.test/admin/commerce-component-ca";
  const caller = Object.freeze({ workloadIdentityId: workloadIdentityRef,
    kind: "admin_workload" as const, audience, environment, region,
    allowedOperations: [operation], siteId: null, bindingEpoch: "1",
    issuedAt: timing.issuedAt, expiresAt: timing.expiresAt, issuer, keyVersion: "component-1" });
  return verifyRequestSecurityContext({ requestId: claimed.command!.commandId,
    correlationId: randomUUID(), trustedCaller: { kind: caller.kind,
      workloadIdentityId: caller.workloadIdentityId, audience, environment, region,
      allowedOperations: caller.allowedOperations, bindingEpoch: caller.bindingEpoch,
      issuedAt: caller.issuedAt, expiresAt: caller.expiresAt },
    actor: { kind: "operator", subjectId: claimed.actorRef,
      subjectGeneration: claimed.operatorGeneration.toString() }, delegatedGrant: null,
    target: { siteId, workspaceId: null, projectId: null, purpose: operation,
      scopes: ["admin:site", operation] }, audience, environment, region,
    evidence: [{ kind: "workload_attestation", evidenceId: `commerce:${claimed.command!.commandId}`,
      issuer }], policyEpoch: "1", issuedAt: timing.issuedAt, expiresAt: timing.expiresAt }, {
    now: timing.now, operation, expectedAudience: audience, expectedEnvironment: environment,
    expectedRegion: region, callerVerifier: { verify: async () => caller },
  });
}

async function keyRing(): Promise<Readonly<{ path: string; remove(): Promise<void> }>> {
  const directory = await mkdtemp(join(tmpdir(), "kokoro-commerce-component-"));
  const path = join(directory, "redemption-keyring.json");
  const secret = (fill: number) => Buffer.alloc(32, fill).toString("base64url");
  await writeFile(path, JSON.stringify({ version: 1,
    currentCodeLookupKeyRevision: "component-code-v1",
    codeLookupKeys: [{ keyRevision: "component-code-v1", keyBase64url: secret(1) }],
    currentPreviewCredentialKeyRevision: "component-preview-v1",
    previewCredentialKeys: [{ keyRevision: "component-preview-v1", keyBase64url: secret(2) }],
    requestAuditKeyBase64url: secret(3),
  }), { encoding: "utf8", mode: 0o600 });
  return Object.freeze({ path, remove: () => rm(directory, { recursive: true, force: true }) });
}

async function cleanup(bootstrap: Client, siteId: string, foreignSiteId: string,
  commandIds: readonly string[]): Promise<void> {
  await bootstrap.query("BEGIN");
  try {
    await bootstrap.query("SET LOCAL session_replication_role='replica'");
    for (const relation of [
      "commerce_redeem_code", "commerce_code_batch_approval", "commerce_code_secret_export",
      "commerce_code_batch", "commerce_redemption_program_availability",
      "commerce_redemption_program_revision", "commerce_catalog_product_version",
      "commerce_fulfillment_program_output", "commerce_fulfillment_program_revision",
      "commerce_catalog_plan_version", "commerce_catalog_plan",
      "commerce_entitlement_template_revision", "commerce_credit_program_revision",
      "commerce_catalog_product", "commerce_audit_entry", "commerce_command",
    ]) {
      await bootstrap.query(`DELETE FROM platform.${relation} WHERE site_ref=$1`, [siteId]);
    }
    await bootstrap.query("DELETE FROM platform.command_receipt WHERE command_id=ANY($1::text[])",
      [commandIds]);
    await bootstrap.query("DELETE FROM platform.authorization_site WHERE site_ref=ANY($1::text[])",
      [[siteId, foreignSiteId]]);
    await bootstrap.query("COMMIT");
  } catch (error) {
    await bootstrap.query("ROLLBACK");
    throw error;
  }
}

function leased(value: string | undefined): string {
  if (value === undefined) throw new Error("PLATFORM_POSTGRES_LEASE_URL_REQUIRED");
  const url = new URL(value);
  if (!url.pathname.slice(1).startsWith("kokoro_test_")) {
    throw new Error("DATABASE_URL_PLATFORM_TEST_MUST_BE_LEASED");
  }
  return value;
}

function role(value: string | undefined): string {
  if (value === undefined || !/^[a-z_][a-z0-9_]{0,62}$/u.test(value)) {
    throw new Error("PLATFORM_POSTGRES_ROLE_REQUIRED");
  }
  return value;
}

function required<Value>(value: Value | undefined, code: string): Value {
  if (value === undefined) throw new Error(code);
  return value;
}
