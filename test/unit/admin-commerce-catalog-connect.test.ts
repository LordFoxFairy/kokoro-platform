import { create, getExtension } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import type { HandlerContext } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import {
  CommandDigestAlgorithmV2,
  CommandIdentityV2Schema,
  OperatorAssuranceLevel,
} from "../../src/interfaces/connect/generated-admin-commerce/kokoro/common/v2/command_envelope_pb.js";
import {
  AuthenticatedOperatorCommandContextSchema,
  OperatorScopeSchema,
  SecurityEpochsSchema,
  SiteScopeSchema,
} from "../../src/interfaces/connect/generated-admin-commerce/kokoro/platform/admin/v2/admin_shared_pb.js";
import {
  CreditProgramRevisionSummarySchema,
  CreditBucketClass,
  CreditRolloverPolicy,
  CreditScopePolicySchema,
  EntitlementTemplateRevisionSummarySchema,
  OfferSummarySchema,
  PermanentCreditWindowPolicySchema,
  PlanVersionDraftSchema,
  PublishCreditProgramRevisionEffectSchema,
  PublishCreditProgramRevisionRequestSchema,
  PublishEntitlementTemplateRevisionEffectSchema,
  PublishEntitlementTemplateRevisionRequestSchema,
  PublishOfferEffectSchema,
  PublishRedemptionProgramEffectSchema,
  RecurringCreditWindowPolicySchema,
  RedemptionProgramSummarySchema,
} from "../../src/interfaces/connect/generated-admin-commerce/kokoro/platform/commerce/v1/admin_commerce_pb.js";
import { field as validationField } from
  "../../src/interfaces/connect/generated-admin-commerce/buf/validate/validate_pb.js";
import {
  publishCreditProgramRevisionRequestDigest,
  publishEntitlementTemplateRevisionRequestDigest,
  type VerifiedAuthenticatedAdminAxes,
} from "../../src/interfaces/connect/generated-admin-commerce/command-envelope-digest.js";
import { createAdminCommerceConnectService } from
  "../../src/modules/commerce/interfaces/connect/admin-commerce-service.js";
import { HmacAdminPageCursorCodec } from
  "../../src/modules/admin/infrastructure/security/admin-page-cursor.js";
import type { VerifiedRequestSecurityContext } from "../../src/shared/security-context/index.js";

const transport = {} as HandlerContext;
const authenticatedAt = timestampFromDate(new Date("2026-07-30T00:00:00.000Z"));
const stepUpAt = timestampFromDate(new Date("2026-07-30T00:01:00.000Z"));
const axes: VerifiedAuthenticatedAdminAxes = Object.freeze({
  workloadIdentityRef: "spiffe://kokoro/web-admin", audience: "platform-admin",
  actorRef: "operator:7", operatorGeneration: 2n, operatorSessionRef: "session:9",
  environment: "production", region: "us-east-1", managedDeviceRef: "device:3",
  assuranceLevel: OperatorAssuranceLevel.PHISHING_RESISTANT,
  factorClasses: Object.freeze(["oidc", "webauthn"]), authenticatedAt, stepUpAt,
  operatorAttestationRef: "attestation:7", operatorAttestationDigest: "a".repeat(64),
});

describe("AdminCommerce catalog primitive Connect provider", () => {
  it("keeps every Commerce uint64 persisted as PostgreSQL BIGINT within INT64_MAX", () => {
    const persistedFields = [
      [RecurringCreditWindowPolicySchema, ["expires_after_seconds"]],
      [PublishCreditProgramRevisionEffectSchema, ["revision"]],
      [CreditProgramRevisionSummarySchema, ["revision"]],
      [PublishEntitlementTemplateRevisionEffectSchema, ["revision", "expires_after_seconds"]],
      [EntitlementTemplateRevisionSummarySchema, ["revision", "expires_after_seconds"]],
      [PlanVersionDraftSchema, ["revision", "term_seconds"]],
      [PublishOfferEffectSchema, ["product_revision", "fulfillment_program_revision"]],
      [OfferSummarySchema, ["revision"]],
      [PublishRedemptionProgramEffectSchema, ["revision"]],
      [RedemptionProgramSummarySchema, ["revision"]],
    ] as const;
    for (const [schema, fieldNames] of persistedFields) {
      for (const fieldName of fieldNames) {
        const descriptor = schema.fields.find((candidate) => candidate.name === fieldName);
        expect(descriptor, `${schema.typeName}.${fieldName}`).toBeDefined();
        const rules = getExtension(descriptor!.proto.options!, validationField);
        expect(rules.type.case, `${schema.typeName}.${fieldName}`).toBe("uint64");
        if (rules.type.case !== "uint64") throw new Error("COMMERCE_UINT64_RULE_MISSING");
        expect(rules.type.value.lessThan, `${schema.typeName}.${fieldName}`).toEqual({
          case: "lte", value: 9_223_372_036_854_775_807n,
        });
      }
    }
  });

  it("authorizes and publishes a CreditProgram using the exact typed digest and Site scope", async () => {
    const persistedCommandId = "018f1212-1212-7212-8212-121212121211";
    const publish = vi.fn(async (input: { requestDigest: string }) => ({ kind: "committed" as const,
      creditProgramRevisionRef: "credits-v1", revisionDigest: "b".repeat(64),
      publishedAt: "2026-07-30T01:00:00.000Z", command: {
        commandId: persistedCommandId, idempotencyKey: "catalog-key-0001",
        requestDigest: input.requestDigest, environment: "production", region: "us-east-1",
        callerIdentity: "admin-1:operator:7", operation: "commerce.credit-program.publish",
      } }));
    const resolveCommerceCommand = vi.fn(async () => ({ context: internalContext(
      "commerce.credit-program.publish"), axes }));
    const service = harness({ publishCreditProgramRevision: publish, resolveCommerceCommand });
    const context = commandContext();
    const effect = create(PublishCreditProgramRevisionEffectSchema, {
      creditProgramRevisionRef: "credits-v1", programRef: "credits", revision: 1n,
      uxBucketClass: CreditBucketClass.PERMANENT, unit: "kokoro-credit", amount: "1000",
      burnPriority: 1000, scopePolicy: create(CreditScopePolicySchema, {
        surfaceRefs: ["studio", "chat"], capabilityKeys: ["model.chat"], agentRefs: [],
        allowUnattributedAgent: true,
      }), liabilityMerchantAccountRef: "merchant:main",
      windowPolicy: { case: "permanentWindow", value: create(PermanentCreditWindowPolicySchema, {
        rolloverPolicy: CreditRolloverPolicy.NONE,
      }) },
    });
    context.command!.requestDigest = publishCreditProgramRevisionRequestDigest(context, "site-1", effect, axes);

    await expect(service.publishCreditProgramRevision(create(PublishCreditProgramRevisionRequestSchema, {
      context, siteId: "site-1", effect,
    }), transport)).resolves.toMatchObject({ creditProgramRevision: {
      siteId: "site-1", creditProgramRevisionRef: "credits-v1", amount: "1000",
      uxBucketClass: CreditBucketClass.PERMANENT, revisionDigest: "b".repeat(64),
    }, receipt: { identity: { commandId: persistedCommandId } } });
    expect(resolveCommerceCommand).toHaveBeenCalledWith(context, transport, {
      operation: "commerce.credit-program.publish", siteRef: "site-1",
      resourceRefs: ["credits-v1", "credits"],
    });
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      requestDigest: context.command!.requestDigest, uxBucketClass: "permanent",
      scopePolicy: { surfaceRefs: ["chat", "studio"], capabilityKeys: ["model.chat"],
        agentRefs: [], allowUnattributedAgent: true },
    }));

    context.command!.requestDigest = "f".repeat(64);
    await expect(service.publishCreditProgramRevision(create(PublishCreditProgramRevisionRequestSchema, {
      context, siteId: "site-1", effect,
    }), transport)).rejects.toThrow("COMMERCE_COMMAND_DIGEST_MISMATCH");
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("publishes an EntitlementTemplate through its independent permission", async () => {
    const publish = vi.fn(async (input: { requestDigest: string }) => ({ kind: "committed" as const,
      entitlementTemplateRevisionRef: "premium-v1", revisionDigest: "c".repeat(64),
      publishedAt: "2026-07-30T01:00:00.000Z", command: {
        commandId: "018f1212-1212-7212-8212-121212121212", idempotencyKey: "catalog-key-0001",
        requestDigest: input.requestDigest, environment: "production", region: "us-east-1",
        callerIdentity: "admin-1:operator:7", operation: "commerce.entitlement-template.publish",
      } }));
    const resolveCommerceCommand = vi.fn(async () => ({ context: internalContext(
      "commerce.entitlement-template.publish"), axes }));
    const service = harness({ publishEntitlementTemplateRevision: publish, resolveCommerceCommand });
    const context = commandContext();
    const effect = create(PublishEntitlementTemplateRevisionEffectSchema, {
      entitlementTemplateRevisionRef: "premium-v1", templateRef: "premium", revision: 1n,
      capabilityKey: "chat.premium", safeLabel: "Premium chat", expiresAfterSeconds: 3600n,
    });
    context.command!.requestDigest = publishEntitlementTemplateRevisionRequestDigest(
      context, "site-1", effect, axes);

    await expect(service.publishEntitlementTemplateRevision(create(
      PublishEntitlementTemplateRevisionRequestSchema, { context, siteId: "site-1", effect },
    ), transport)).resolves.toMatchObject({ entitlementTemplateRevision: {
      entitlementTemplateRevisionRef: "premium-v1", capabilityKey: "chat.premium",
      expiresAfterSeconds: 3600n,
    } });
    expect(resolveCommerceCommand).toHaveBeenCalledWith(context, transport, {
      operation: "commerce.entitlement-template.publish", siteRef: "site-1",
      resourceRefs: ["premium-v1", "premium"],
    });
  });

  it("uses a database-issued watermark and round-trips the full signed cursor", async () => {
    const captureWatermark = vi.fn(async () => "2026-07-30T02:00:00.000Z");
    const listCreditProgramRevisions = vi.fn(async () => []);
    const cursors = new HmacAdminPageCursorCodec(Buffer.alloc(32, 7));
    const service = createAdminCommerceConnectService({
      resolver: { resolve: async () => ({ operatorRef: "operator:7", environment: "production",
        region: "us-east-1", operation: "commerce.credit-program.read",
        authorityBindingDigest: "a".repeat(64),
        scope: { kind: "site", siteRefs: ["site-1"] } }) } as never,
      owner: {} as never,
      reader: { captureWatermark, listCreditProgramRevisions } as never,
      cursors,
      clock: () => new Date("2099-01-01T00:00:00.000Z"),
    });
    await expect(service.listCreditProgramRevisions({ context: {},
      siteId: "site-1", pageSize: 200 } as never, transport))
      .resolves.toEqual({ creditProgramRevisions: [] });
    expect(captureWatermark).toHaveBeenCalledOnce();
    expect(listCreditProgramRevisions).toHaveBeenCalledWith(expect.anything(), {
      siteId: "site-1", afterRef: null, watermark: "2026-07-30T02:00:00.000Z", limit: 201,
    });
    const token = cursors.encode({ kind: "credit-program-revisions", after: "x".repeat(256),
      watermark: "2026-07-30T02:00:00.000Z", binding: "b".repeat(64) });
    expect(token.length).toBeLessThanOrEqual(1024);
    expect(cursors.decode(token)).toEqual({ kind: "credit-program-revisions", after: "x".repeat(256),
      watermark: "2026-07-30T02:00:00.000Z", binding: "b".repeat(64) });
  });
});

function harness(overrides: Readonly<Record<string, unknown>>) {
  return createAdminCommerceConnectService({
    resolver: { resolveCommerceCommand: overrides.resolveCommerceCommand } as never,
    owner: {
      publishCreditProgramRevision: overrides.publishCreditProgramRevision,
      publishEntitlementTemplateRevision: overrides.publishEntitlementTemplateRevision,
    } as never,
    reader: {} as never,
    cursors: {} as never,
  });
}

function commandContext() {
  return create(AuthenticatedOperatorCommandContextSchema, {
    command: create(CommandIdentityV2Schema, {
      commandId: "018f1212-1212-7212-8212-121212121212",
      idempotencyKey: "catalog-key-0001",
      digestAlgorithm: CommandDigestAlgorithmV2.SHA256_COMMAND_ENVELOPE,
      requestDigest: "0".repeat(64),
    }), actorRef: axes.actorRef, operatorGeneration: axes.operatorGeneration,
    operatorSessionRef: axes.operatorSessionRef, environment: axes.environment, region: axes.region,
    managedDeviceRef: axes.managedDeviceRef, assuranceLevel: axes.assuranceLevel,
    factorClasses: [...axes.factorClasses], authenticatedAt, stepUpAt,
    operatorAttestationRef: axes.operatorAttestationRef,
    operatorAttestationDigest: axes.operatorAttestationDigest,
    securityEpochs: create(SecurityEpochsSchema, { operatorSecurityEpoch: 1n, sessionEpoch: 1n,
      restrictionEpoch: 1n, policyEpoch: 1n, siteSecurityEpoch: 1n }),
    scope: create(OperatorScopeSchema, { kind: { case: "site", value: create(SiteScopeSchema, {
      siteIds: ["site-1"], environment: axes.environment, region: axes.region,
    }) } }),
  });
}

function internalContext(operation: string): VerifiedRequestSecurityContext {
  return { environment: "production", region: "us-east-1", audience: "platform-admin",
    trustedCaller: { kind: "admin_workload", workloadIdentityId: "admin-1" },
    actor: { kind: "operator", subjectId: "operator:7", subjectGeneration: "2" },
    target: { siteId: "site-1", purpose: operation } } as VerifiedRequestSecurityContext;
}
