import { create } from "@bufbuild/protobuf";
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
  CreditBucketClass,
  CreditScopePolicySchema,
  PublishCreditProgramRevisionEffectSchema,
  PublishCreditProgramRevisionRequestSchema,
  PublishEntitlementTemplateRevisionEffectSchema,
  PublishEntitlementTemplateRevisionRequestSchema,
} from "../../src/interfaces/connect/generated-admin-commerce/kokoro/platform/commerce/v1/admin_commerce_pb.js";
import {
  publishCreditProgramRevisionRequestDigest,
  publishEntitlementTemplateRevisionRequestDigest,
  type VerifiedAuthenticatedAdminAxes,
} from "../../src/interfaces/connect/generated-admin-commerce/command-envelope-digest.js";
import { createAdminCommerceConnectService } from
  "../../src/modules/commerce/interfaces/connect/admin-commerce-service.js";
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
  it("authorizes and publishes a CreditProgram using the exact typed digest and Site scope", async () => {
    const publish = vi.fn(async () => ({ kind: "committed" as const,
      creditProgramRevisionRef: "credits-v1", revisionDigest: "b".repeat(64),
      publishedAt: "2026-07-30T01:00:00.000Z" }));
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
    });
    context.command!.requestDigest = publishCreditProgramRevisionRequestDigest(context, "site-1", effect, axes);

    await expect(service.publishCreditProgramRevision(create(PublishCreditProgramRevisionRequestSchema, {
      context, siteId: "site-1", effect,
    }), transport)).resolves.toMatchObject({ creditProgramRevision: {
      siteId: "site-1", creditProgramRevisionRef: "credits-v1", amount: "1000",
      uxBucketClass: CreditBucketClass.PERMANENT, revisionDigest: "b".repeat(64),
    } });
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
    const publish = vi.fn(async () => ({ kind: "committed" as const,
      entitlementTemplateRevisionRef: "premium-v1", revisionDigest: "c".repeat(64),
      publishedAt: "2026-07-30T01:00:00.000Z" }));
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
