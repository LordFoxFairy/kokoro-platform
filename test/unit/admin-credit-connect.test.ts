import { create } from "@bufbuild/protobuf";
import type { HandlerContext } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import { AuthenticatedOperatorQueryContextSchema } from
  "../../src/interfaces/connect/generated-admin-credit/kokoro/platform/admin/v2/admin_shared_pb.js";
import { CreditReadFreshness, GetSiteCreditSummaryRequestSchema,
  ListCreditGrantsRequestSchema } from
  "../../src/interfaces/connect/generated-admin-credit/kokoro/platform/credit/v1/admin_credit_pb.js";
import { HmacAdminPageCursorCodec } from
  "../../src/modules/admin/infrastructure/security/admin-page-cursor.js";
import { createAdminCreditConnectService } from
  "../../src/modules/credit/interfaces/connect/admin-credit-service.js";

const transport = {} as HandlerContext;
const context = create(AuthenticatedOperatorQueryContextSchema, { requestId: "request-001" });
const permit = { operatorRef: "operator:1", environment: "production", region: "us-east-1",
  operation: "credit.summary.read", scope: { kind: "site", siteRefs: ["site-1"] } } as const;

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
      siteId: "site-1", freshness: CreditReadFreshness.AUTHORITATIVE_TRANSACTION_SNAPSHOT,
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
    const listCreditGrants = vi.fn(async () => [
      grant("33333333-3333-4333-8333-333333333333"),
      grant("44444444-4444-4444-8444-444444444444"),
    ]);
    const service = harness({ resolve, listCreditGrants });
    const first = await service.listCreditGrants(create(ListCreditGrantsRequestSchema, {
      context, siteId: "site-1", sourceRef: "redeem:1", pageSize: 1,
    }), transport);
    expect(first.grants).toHaveLength(1);
    expect(first.nextPageToken).toBeTypeOf("string");
    expect(listCreditGrants).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      siteId: "site-1", sourceRef: "redeem:1", limit: 2,
    }));

    await expect(service.listCreditGrants(create(ListCreditGrantsRequestSchema, {
      context, siteId: "site-1", sourceRef: "redeem:2", pageSize: 1,
      pageToken: first.nextPageToken,
    }), transport)).rejects.toThrow("ADMIN_CREDIT_PAGE_TOKEN_INVALID");
  });
});

function harness(overrides: Readonly<Record<string, unknown>>) {
  return createAdminCreditConnectService({
    resolver: { resolve: overrides.resolve } as never,
    reader: {
      getSiteCreditSummary: overrides.getSiteCreditSummary,
      listCreditGrants: overrides.listCreditGrants,
    } as never,
    cursors: new HmacAdminPageCursorCodec(new Uint8Array(32).fill(7)),
    clock: () => new Date("2026-07-30T01:00:00.000Z"),
  });
}
