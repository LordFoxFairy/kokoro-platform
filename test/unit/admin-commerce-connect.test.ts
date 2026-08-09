import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import type { HandlerContext } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
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
} from "../../src/generated/proto/kokoro/platform/admin/v2/admin_shared_pb.js";
import {
  CommercePageRequestSchema,
  CommerceSiteCommandContextSchema,
  CommerceSiteQueryContextSchema,
  ListOfferRevisionsRequestSchema,
  ListRedemptionProgramRevisionsRequestSchema,
} from "../../src/generated/proto/kokoro/platform/commerce/v1/commerce_catalog_pb.js";
import {
  IssueCodeBatchEffectSchema,
  IssueCodeBatchRequestSchema,
} from "../../src/generated/proto/kokoro/platform/commerce/v1/commerce_control_pb.js";
import {
  issueCodeBatchRequestDigest,
  type VerifiedCommerceSiteAxes,
} from "../../src/generated/contracts/platform-admin-commerce@v1/digest.js";
import { HmacAdminPageCursorCodec } from
  "../../src/modules/admin/infrastructure/security/admin-page-cursor.js";
import { createAdminCommerceConnectService } from
  "../../src/modules/commerce/interfaces/connect/admin-commerce-service.js";
import type { VerifiedRequestSecurityContext } from
  "../../src/shared/security-context/request-security-context.js";

const transport = {} as HandlerContext;
const observedAt = "2026-07-30T12:00:00.000Z";
const siteId = "site:alpha";
const batchRef = "22222222-2222-4222-8222-222222222222";
const rawCode = "KC1-01234567-0123456789-0123456789ABCDEFGHJKMNPQRSTVWXYZ-01234567";

describe("AdminCommerce Connect provider", () => {
  it("implements the exact generated 10-write and 10-read method set", () => {
    expect(Object.keys(harness().service).sort()).toEqual([
      "abandonCodeBatch", "activateCodeBatch", "approveCodeBatch",
      "getCodeBatch", "getCreditProgramRevision", "getEntitlementTemplateRevision",
      "getOfferRevision", "getRedemptionProgramRevision", "issueCodeBatch",
      "listCodeBatches", "listCreditProgramRevisions", "listEntitlementTemplateRevisions",
      "listOfferRevisions", "listRedemptionProgramRevisions", "publishCreditProgramRevision",
      "publishEntitlementTemplateRevision", "publishOfferRevision",
      "publishRedemptionProgramRevision", "revokeCodeBatch", "suspendCodeBatch",
    ].sort());
  });

  it("Protovalidates a request before resolving any authority", async () => {
    const setup = harness();
    await expect(setup.service.issueCodeBatch(create(IssueCodeBatchRequestSchema), transport))
      .rejects.toThrow("COMMERCE_ADMIN_REQUEST_INVALID");
    expect(setup.resolver.resolveCommerceCommand).not.toHaveBeenCalled();
    expect(setup.owner.issueBatch).not.toHaveBeenCalled();
  });

  it("verifies the generated digest against server-resolved Site axes and exports codes only once", async () => {
    const setup = harness();
    const effect = create(IssueCodeBatchEffectSchema, {
      batchRef, redemptionProgramRevisionRef: "redemption-program-revision:3", count: 1,
    });
    const context = commandContext("0".repeat(64));
    context.operator!.command!.requestDigest = issueCodeBatchRequestDigest(context, effect, axes);
    setup.owner.issueBatch.mockResolvedValueOnce({
      kind: "secret_export", command: ownerCommand("commerce.code-batch.issue"), recordedAt: observedAt,
      batchRef, codeCount: 1, redemptionProgramRevisionRef: effect.redemptionProgramRevisionRef,
      createdByOperatorRef: axes.actorRef, startsAt: null, endsAt: null,
      codes: [rawCode], exportedAt: observedAt,
    }).mockResolvedValueOnce({
      kind: "delivery_unavailable", command: ownerCommand("commerce.code-batch.issue"),
      recordedAt: observedAt, batchRef, codeCount: 1,
      redemptionProgramRevisionRef: effect.redemptionProgramRevisionRef,
      createdByOperatorRef: axes.actorRef, startsAt: null, endsAt: null, exportedAt: observedAt,
    });
    const request = create(IssueCodeBatchRequestSchema, { context, effect });

    const first = await setup.service.issueCodeBatch(request, transport);
    expect(first.disposition).toBe(1);
    expect(first.delivery).toEqual({ case: "secretExport", value: expect.objectContaining({
      rawCodes: [rawCode],
    }) });
    expect(setup.owner.issueBatch).toHaveBeenCalledWith(expect.objectContaining({
      context: verifiedContext, siteId, requestDigest: context.operator!.command!.requestDigest,
      batchRef, count: 1,
    }));
    expect(setup.resolver.resolveCommerceCommand).toHaveBeenCalledWith(
      context.operator, transport, expect.objectContaining({
        operation: "commerce.code-batch.issue", siteRef: siteId,
        resourceRefs: [batchRef, effect.redemptionProgramRevisionRef],
      }),
    );

    const replay = await setup.service.issueCodeBatch(request, transport);
    expect(replay.disposition).toBe(2);
    expect(replay.delivery).toEqual({ case: "deliveryUnavailable", value: expect.anything() });
    expect(replay.delivery!.case).not.toBe("secretExport");
  });

  it("rejects a server-resolved Site axis mismatch before calling the owner", async () => {
    const setup = harness();
    const effect = create(IssueCodeBatchEffectSchema, {
      batchRef, redemptionProgramRevisionRef: "redemption-program-revision:3", count: 1,
    });
    const context = commandContext("0".repeat(64));
    context.operator!.command!.requestDigest = issueCodeBatchRequestDigest(context, effect, axes);
    setup.resolver.resolveCommerceCommand.mockResolvedValueOnce({
      context: verifiedContext,
      axes: Object.freeze({ ...axes, siteId: "site:other" }),
    });

    await expect(setup.service.issueCodeBatch(create(IssueCodeBatchRequestSchema, {
      context, effect,
    }), transport)).rejects.toThrow("command_envelope_axis_mismatch:siteId");
    expect(setup.owner.issueBatch).not.toHaveBeenCalled();
  });

  it("binds continuation cursors to family, Site, permit, watermark, afterRef and first observedAt", async () => {
    const setup = harness();
    setup.reader.observeCatalog.mockResolvedValue({ watermark: "41", observedAt });
    setup.reader.listOffers.mockResolvedValue([
      offer("offer:v1"), offer("offer:v2"),
    ]);
    const request = create(ListOfferRevisionsRequestSchema, {
      context: queryContext(siteId), page: create(CommercePageRequestSchema, { pageSize: 1 }),
    });
    const first = await setup.service.listOfferRevisions(request, transport);

    expect(first.items).toHaveLength(1);
    expect(first.observedAt).toEqual(timestampFromDate(new Date(observedAt)));
    expect(first.nextPageToken).toBeTypeOf("string");
    expect(setup.reader.listOffers).toHaveBeenCalledWith(permit("commerce.offer.read", siteId), {
      siteId, afterRef: null, watermark: "41", limit: 2,
    });

    setup.reader.listOffers.mockResolvedValue([]);
    const second = await setup.service.listOfferRevisions(create(ListOfferRevisionsRequestSchema, {
      context: queryContext(siteId), page: create(CommercePageRequestSchema, {
        pageSize: 1, pageToken: first.nextPageToken,
      }),
    }), transport);
    expect(second.observedAt).toEqual(first.observedAt);
    expect(setup.reader.observeCatalog).toHaveBeenCalledTimes(1);
    expect(setup.reader.listOffers).toHaveBeenLastCalledWith(expect.anything(), {
      siteId, afterRef: "offer:v1", watermark: "41", limit: 2,
    });

    const tampered = `${first.nextPageToken![0] === "A" ? "B" : "A"}${first.nextPageToken!.slice(1)}`;
    await expect(setup.service.listOfferRevisions(create(ListOfferRevisionsRequestSchema, {
      context: queryContext(siteId), page: create(CommercePageRequestSchema, {
        pageSize: 1, pageToken: tampered,
      }),
    }), transport)).rejects.toThrow("ADMIN_PAGE_TOKEN_INVALID");
    await expect(setup.service.listRedemptionProgramRevisions(
      create(ListRedemptionProgramRevisionsRequestSchema, {
        context: queryContext(siteId), page: create(CommercePageRequestSchema, {
          pageSize: 1, pageToken: first.nextPageToken,
        }),
      }), transport,
    )).rejects.toThrow("COMMERCE_ADMIN_PAGE_TOKEN_INVALID");
    await expect(setup.service.listOfferRevisions(create(ListOfferRevisionsRequestSchema, {
      context: queryContext("site:other"), page: create(CommercePageRequestSchema, {
        pageSize: 1, pageToken: first.nextPageToken,
      }),
    }), transport)).rejects.toThrow("COMMERCE_ADMIN_PAGE_TOKEN_INVALID");

    setup.resolver.resolve.mockResolvedValueOnce(permit("commerce.offer.read", siteId, "b"));
    await expect(setup.service.listOfferRevisions(create(ListOfferRevisionsRequestSchema, {
      context: queryContext(siteId), page: create(CommercePageRequestSchema, {
        pageSize: 1, pageToken: first.nextPageToken,
      }),
    }), transport)).rejects.toThrow("COMMERCE_ADMIN_PAGE_TOKEN_INVALID");
    expect(setup.reader.listOffers).toHaveBeenCalledTimes(2);
  });
});

const authenticatedAt = timestampFromDate(new Date("2026-07-30T11:00:00.000Z"));
const stepUpAt = timestampFromDate(new Date("2026-07-30T11:05:00.000Z"));
const axes: VerifiedCommerceSiteAxes = Object.freeze({
  siteId, workloadIdentityRef: "workload:web-admin", audience: "platform-admin",
  actorRef: "operator:7", operatorGeneration: 12n, operatorSessionRef: "session:9",
  environment: "production", region: "us-east-1", managedDeviceRef: "device:3",
  assuranceLevel: OperatorAssuranceLevel.PHISHING_RESISTANT,
  factorClasses: Object.freeze(["webauthn", "oidc"]), authenticatedAt, stepUpAt,
  operatorAttestationRef: "attestation:operator:7:12",
  operatorAttestationDigest: "a".repeat(64),
});

const verifiedContext = { environment: "production", region: "us-east-1",
  trustedCaller: { kind: "admin_workload", workloadIdentityId: "workload:web-admin" },
  actor: { kind: "operator", subjectId: "operator:7", subjectGeneration: "12" },
  target: { siteId, purpose: "commerce.code-batch.issue" } } as VerifiedRequestSecurityContext;

function commandContext(requestDigest: string) {
  return create(CommerceSiteCommandContextSchema, { siteId,
    operator: create(AuthenticatedOperatorCommandContextSchema, {
      command: create(CommandIdentityV2Schema, {
        commandId: "11111111-1111-4111-8111-111111111111",
        idempotencyKey: "idempotency:commerce:1",
        digestAlgorithm: CommandDigestAlgorithmV2.SHA256_COMMAND_ENVELOPE, requestDigest,
      }),
      actorRef: axes.actorRef, operatorGeneration: axes.operatorGeneration,
      operatorSessionRef: axes.operatorSessionRef, environment: axes.environment, region: axes.region,
      managedDeviceRef: axes.managedDeviceRef, assuranceLevel: axes.assuranceLevel,
      factorClasses: ["oidc", "webauthn"], authenticatedAt, stepUpAt,
      operatorAttestationRef: axes.operatorAttestationRef,
      operatorAttestationDigest: axes.operatorAttestationDigest,
      securityEpochs: create(SecurityEpochsSchema, { operatorSecurityEpoch: 2n,
        sessionEpoch: 11n, restrictionEpoch: 3n, policyEpoch: 5n, siteSecurityEpoch: 7n }),
      scope: siteScope(siteId),
    }) });
}

function queryContext(site: string) {
  return create(CommerceSiteQueryContextSchema, { siteId: site,
    operator: create(AuthenticatedOperatorQueryContextSchema, {
      requestId: "request:commerce:1", actorRef: axes.actorRef,
      operatorGeneration: axes.operatorGeneration, operatorSessionRef: axes.operatorSessionRef,
      environment: axes.environment, region: axes.region, managedDeviceRef: axes.managedDeviceRef,
      assuranceLevel: axes.assuranceLevel, factorClasses: ["oidc", "webauthn"],
      authenticatedAt, stepUpAt, operatorAttestationRef: axes.operatorAttestationRef,
      operatorAttestationDigest: axes.operatorAttestationDigest,
      securityEpochs: create(SecurityEpochsSchema, { operatorSecurityEpoch: 2n,
        sessionEpoch: 11n, restrictionEpoch: 3n, policyEpoch: 5n, siteSecurityEpoch: 7n }),
      scope: siteScope(site),
    }) });
}

function siteScope(site: string) {
  return create(OperatorScopeSchema, { kind: { case: "site", value: create(SiteScopeSchema, {
    siteIds: [site], environment: axes.environment, region: axes.region,
  }) } });
}

function permit(operation: string, site: string, digestPrefix = "a") {
  return Object.freeze({ operatorRef: axes.actorRef, environment: axes.environment, region: axes.region,
    operation, authorityBindingDigest: digestPrefix.repeat(64),
    scope: { kind: "site" as const, siteRefs: Object.freeze([site]) } });
}

function offer(productVersionRef: string) {
  return Object.freeze({ siteId, productRef: "product:credits", productKind: "credit_pack" as const,
    productVersionRef, revision: 1n, safeLabel: "Credit pack", planVersion: null,
    fulfillmentProgramRevisionRef: "fulfillment:v1", outputs: Object.freeze([Object.freeze({
      outputLineId: "credits", ordinal: 1, cardinality: 1, outputKind: "credit_grant" as const,
      targetRevisionRef: "credit-program:v1",
    })]), legalTermRefs: Object.freeze([]), publishedAt: observedAt });
}

function ownerCommand(operation: string) {
  return Object.freeze({ commandId: "11111111-1111-4111-8111-111111111111",
    environment: axes.environment, region: axes.region,
    callerIdentity: `${axes.workloadIdentityRef}:${axes.actorRef}`, operation,
    idempotencyKey: "idempotency:commerce:1", requestDigest: "b".repeat(64) });
}

function harness() {
  const resolver = {
    resolveCommerceCommand: vi.fn(async () => ({ context: verifiedContext, axes })),
    resolve: vi.fn(async (_context, _transport, request) => permit(request.operation, request.siteRef!)),
  };
  const owner = {
    publishCreditProgramRevision: vi.fn(), publishEntitlementTemplateRevision: vi.fn(),
    publishOffer: vi.fn(), publishProgram: vi.fn(), issueBatch: vi.fn(), approveBatch: vi.fn(),
    activateBatch: vi.fn(), abandonBatch: vi.fn(), suspendBatch: vi.fn(), revokeBatch: vi.fn(),
  };
  const reader = {
    observeCatalog: vi.fn(), getCreditProgramRevision: vi.fn(), listCreditProgramRevisions: vi.fn(),
    getEntitlementTemplateRevision: vi.fn(), listEntitlementTemplateRevisions: vi.fn(),
    getOffer: vi.fn(), listOffers: vi.fn(), getRedemptionProgram: vi.fn(),
    listRedemptionPrograms: vi.fn(), getCodeBatch: vi.fn(), listCodeBatches: vi.fn(),
  };
  const service = createAdminCommerceConnectService({ owner: owner as never, resolver: resolver as never,
    reader: reader as never, cursors: new HmacAdminPageCursorCodec(new Uint8Array(32).fill(9)) });
  return { service, owner, reader, resolver };
}
