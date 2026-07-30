import { create } from "@bufbuild/protobuf";
import type { HandlerContext } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import { AuthenticatedOperatorQueryContextSchema } from
  "../../src/interfaces/connect/generated-admin-credit/kokoro/platform/admin/v2/admin_shared_pb.js";
import { CreditGrantSourceType, CreditReadFreshness, CreditUsageSourceDirection,
  GetSiteCreditSummaryRequestSchema, ListCreditGrantsRequestSchema,
  ListCreditHoldAllocationsRequestSchema, ListRatedUsageSourceAllocationsRequestSchema } from
  "../../src/interfaces/connect/generated-admin-credit/kokoro/platform/credit/v1/admin_credit_pb.js";
import { HmacAdminPageCursorCodec } from
  "../../src/modules/admin/infrastructure/security/admin-page-cursor.js";
import { createAdminCreditConnectService } from
  "../../src/modules/credit/interfaces/connect/admin-credit-service.js";

const transport = {} as HandlerContext;
const context = create(AuthenticatedOperatorQueryContextSchema, { requestId: "request-001" });
const permit = { operatorRef: "operator:1", environment: "production", region: "us-east-1",
  operation: "credit.summary.read", authorityBindingDigest: "a".repeat(64),
  scope: { kind: "site", siteRefs: ["site-1"] } } as const;

describe("AdminCredit Connect provider", () => {
  it("binds a Site summary read to the exact Credit permission and authoritative as-of", async () => {
    const resolve = vi.fn(async () => permit);
    const getSiteCreditSummary = vi.fn(async () => ({ siteId: "site-1", creditAccountCount: 2n,
      activeCreditAccountCount: 1n, openHoldCount: 3n, reconciliationRequiredHoldCount: 1n,
      balances: [{ unit: "credit", availableAmount: "100", reservedAmount: "20",
        consumedAmount: "30", expiredAmount: "0", revokedAmount: "0",
        recoveryExposureAmount: "0" }], asOf: "2026-07-30T00:00:00.000Z" }));
    const service = harness({ resolve, getSiteCreditSummary });

    await expect(service.getSiteCreditSummary(create(GetSiteCreditSummaryRequestSchema, {
      context, siteId: "site-1",
    }), transport)).resolves.toMatchObject({ summary: {
      siteId: "site-1", freshness: CreditReadFreshness.AUTHORITATIVE_DATABASE_OBSERVATION,
      creditAccountCount: 2n, balances: [{ availableAmount: "100" }],
    } });
    expect(resolve).toHaveBeenCalledWith(context, transport, expect.objectContaining({
      operation: "credit.summary.read", siteRef: "site-1", resourceRefs: ["site-1"],
    }));
    expect(getSiteCreditSummary).toHaveBeenCalledWith(permit, "site-1");
  });

  it("binds opaque Grant cursors to Site, permission and trace filters", async () => {
    const resolve = vi.fn(async () => ({ ...permit, operation: "credit.grant.read" }));
    const grant = (id: string) => ({ siteId: "site-1", creditGrantId: id,
      creditAccountRef: "11111111-1111-4111-8111-111111111111", billingAccountRef: "billing:1",
      creditProgramRevisionRef: "program:v1", sourceType: "redemption" as const,
      sourceRef: "redeem:1", issuanceJournalTransactionRef: "22222222-2222-4222-8222-222222222222",
      uxBucketClass: "permanent" as const, unit: "credit", originalAmount: "100", burnPriority: 1,
      effectiveAt: "2026-07-30T00:00:00.000Z", expiresAt: null,
      issuedAt: "2026-07-30T00:00:00.000Z", relatedHoldCount: 1n, relatedExecutionCount: 1n });
    const listCreditGrants = vi.fn(async () => ({
      items: [grant("33333333-3333-4333-8333-333333333333"),
        grant("44444444-4444-4444-8444-444444444444")],
      membershipWatermark: "2026-07-30T00:00:00.000Z",
      observedAt: "2026-07-30T00:00:00.000Z",
    }));
    const service = harness({ resolve, listCreditGrants });
    const first = await service.listCreditGrants(create(ListCreditGrantsRequestSchema, {
      context, siteId: "site-1", sourceType: CreditGrantSourceType.REDEMPTION,
      sourceRef: "redeem:1", pageSize: 1,
    }), transport);
    expect(first.grants).toHaveLength(1);
    expect(first.nextPageToken).toBeTypeOf("string");
    expect(listCreditGrants).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      siteId: "site-1", sourceType: "redemption", sourceRef: "redeem:1",
      membershipWatermark: null, limit: 2,
    }));

    await expect(service.listCreditGrants(create(ListCreditGrantsRequestSchema, {
      context, siteId: "site-1", sourceType: CreditGrantSourceType.PAYMENT,
      sourceRef: "redeem:1", pageSize: 1,
      pageToken: first.nextPageToken,
    }), transport)).rejects.toThrow("ADMIN_CREDIT_PAGE_TOKEN_INVALID");
  });

  it("rejects half of a Grant source identity before reading authority facts", async () => {
    const resolve = vi.fn(async () => ({ ...permit, operation: "credit.grant.read" }));
    const listCreditGrants = vi.fn();
    const service = harness({ resolve, listCreditGrants });

    await expect(service.listCreditGrants(create(ListCreditGrantsRequestSchema, {
      context, siteId: "site-1", sourceRef: "shared-ref", pageSize: 10,
    }), transport)).rejects.toThrow("ADMIN_CREDIT_SOURCE_FILTER_INCOMPLETE");
    expect(resolve).not.toHaveBeenCalled();
    expect(listCreditGrants).not.toHaveBeenCalled();
  });

  it("rejects a first page whose membership watermark was not captured at observedAt", async () => {
    const resolve = vi.fn(async () => ({ ...permit, operation: "credit.grant.read" }));
    const listCreditGrants = vi.fn(async () => ({ items: [],
      membershipWatermark: "2026-07-30T00:00:00.000Z",
      observedAt: "2026-07-30T00:00:01.000Z" }));
    const service = harness({ resolve, listCreditGrants });

    await expect(service.listCreditGrants(create(ListCreditGrantsRequestSchema, {
      context, siteId: "site-1", pageSize: 10,
    }), transport)).rejects.toThrow("ADMIN_CREDIT_MEMBERSHIP_WATERMARK_MISMATCH");
  });

  it("invalidates a persisted cursor when verified authority epochs change", async () => {
    const grants = vi.fn(async (_permit, input: { membershipWatermark: string | null }) => ({
      items: input.membershipWatermark === null ? [allocationGrant("3"), allocationGrant("4")] : [],
      membershipWatermark: input.membershipWatermark ?? "2026-07-30T00:00:00.000Z",
      observedAt: input.membershipWatermark ?? "2026-07-30T00:00:00.000Z",
    }));
    const first = harness({ resolve: vi.fn(async () => ({ ...permit, operation: "credit.grant.read" })),
      listCreditGrants: grants });
    const page = await first.listCreditGrants(create(ListCreditGrantsRequestSchema, {
      context, siteId: "site-1", pageSize: 1,
    }), transport);

    const stale = harness({ resolve: vi.fn(async () => ({ ...permit, operation: "credit.grant.read",
      authorityBindingDigest: "b".repeat(64) })), listCreditGrants: grants });
    await expect(stale.listCreditGrants(create(ListCreditGrantsRequestSchema, {
      context, siteId: "site-1", pageSize: 1, pageToken: page.nextPageToken,
    }), transport)).rejects.toThrow("ADMIN_CREDIT_PAGE_TOKEN_INVALID");
    expect(grants).toHaveBeenCalledTimes(1);
  });

  it("exposes hold allocations by either Hold or Grant with database observation semantics", async () => {
    const resolve = vi.fn(async () => ({ ...permit, operation: "credit.hold.read" }));
    const listCreditHoldAllocations = vi.fn(async () => ({ items: [{
      siteId: "site-1", creditHoldRef: "44444444-4444-4444-8444-444444444444",
      creditGrantId: "33333333-3333-4333-8333-333333333333",
      creditAccountRef: "11111111-1111-4111-8111-111111111111", unit: "credit",
      reserveJournalTransactionRef: "22222222-2222-4222-8222-222222222222",
      allocatedAmount: "40", allocationOrdinal: 0, createdAt: "2026-07-30T00:00:00.000Z",
    }], membershipWatermark: "2026-07-30T00:00:00.000Z",
    observedAt: "2026-07-30T00:00:00.000Z" }));
    const service = harness({ resolve, listCreditHoldAllocations });

    const response = await service.listCreditHoldAllocations(create(ListCreditHoldAllocationsRequestSchema, {
      context, siteId: "site-1",
      trace: { case: "creditGrantId", value: "33333333-3333-4333-8333-333333333333" },
      pageSize: 10,
    }), transport);
    expect(response).toMatchObject({ allocations: [{ allocatedAmount: "40", allocationOrdinal: 0 }],
      membershipWatermark: expect.anything(), observedAt: expect.anything() });
    expect(listCreditHoldAllocations).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      creditHoldRef: null, creditGrantId: "33333333-3333-4333-8333-333333333333",
    }));
  });

  it("returns RatedUsage source allocations with the exact Grant direction and amount", async () => {
    const resolve = vi.fn(async () => ({ ...permit, operation: "credit.rated-usage.read" }));
    const listRatedUsageSourceAllocations = vi.fn(async () => ({ items: [{
      siteId: "site-1", ratedUsageRef: "55555555-5555-4555-8555-555555555555",
      settlementRef: "66666666-6666-4666-8666-666666666666",
      creditGrantId: "33333333-3333-4333-8333-333333333333", direction: "capture" as const,
      amount: "12", allocationOrdinal: 1, sourceOrdinal: 0,
    }], membershipWatermark: "2026-07-30T00:00:00.000Z",
    observedAt: "2026-07-30T00:00:00.000Z" }));
    const service = harness({ resolve, listRatedUsageSourceAllocations });

    const response = await service.listRatedUsageSourceAllocations(create(
      ListRatedUsageSourceAllocationsRequestSchema, { context, siteId: "site-1",
        trace: { case: "ratedUsageRef", value: "55555555-5555-4555-8555-555555555555" },
        pageSize: 10 }), transport);
    expect(response.allocations).toMatchObject([{ creditGrantId: "33333333-3333-4333-8333-333333333333",
      direction: CreditUsageSourceDirection.CAPTURE, amount: "12", allocationOrdinal: 1 }]);
  });
});

function allocationGrant(suffix: string) {
  return { siteId: "site-1", creditGrantId: `${suffix.repeat(8)}-${suffix.repeat(4)}-4${suffix.repeat(3)}-8${suffix.repeat(3)}-${suffix.repeat(12)}`,
    creditAccountRef: "11111111-1111-4111-8111-111111111111", billingAccountRef: "billing:1",
    creditProgramRevisionRef: "program:v1", sourceType: "redemption" as const, sourceRef: "redeem:1",
    issuanceJournalTransactionRef: "22222222-2222-4222-8222-222222222222", uxBucketClass: "permanent" as const,
    unit: "credit", originalAmount: "100", burnPriority: 1, effectiveAt: "2026-07-30T00:00:00.000Z",
    expiresAt: null, issuedAt: "2026-07-30T00:00:00.000Z", relatedHoldCount: 1n,
    relatedExecutionCount: 1n };
}

function harness(overrides: Readonly<Record<string, unknown>>) {
  return createAdminCreditConnectService({
    resolver: { resolve: overrides.resolve } as never,
    reader: overrides as never,
    cursors: new HmacAdminPageCursorCodec(new Uint8Array(32).fill(7)),
  });
}
