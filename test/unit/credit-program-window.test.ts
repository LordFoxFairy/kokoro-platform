import { describe, expect, it, vi } from "vitest";
import { CreditProgramWindowService } from
  "../../src/modules/commerce/application/services/credit-program-window.js";

describe("CreditProgramWindowService", () => {
  it("materializes a claimed absolute window through the sole Credit issuance port", async () => {
    const preparation = Object.freeze({ accountCount: 1, grantCount: 1, intentDigest: "a".repeat(64) }) as never;
    const prepareIssuance = vi.fn(async () => ({ kind: "ready" as const, preparation }));
    const issuePrepared = vi.fn(async () => [Object.freeze({
      outputLineId: "daily-credit", outputOrdinal: 2, occurrence: 1,
      creditProgramRevisionRef: "credit-program:daily:v1",
      creditGrantRef: "00000000-0000-7000-8000-000000000101" as never,
      outputVersion: 1 as const, outputDigest: "b".repeat(64),
    })]);
    const recordAcquisition = vi.fn(async () => undefined);
    const service = new CreditProgramWindowService({
      repository: {
        claimDue: async () => [enrollment()],
        recordAcquisition,
      },
      creditGrants: { prepareIssuance, issuePrepared },
      reference: () => "00000000-0000-7000-8000-000000000102",
    });

    await expect(service.issueDue({} as never)).resolves.toBe(1);
    expect(prepareIssuance).toHaveBeenCalledWith(expect.anything(), {
      commandId: null,
      grants: [expect.objectContaining({
        sourceType: "program_window", sourceRef: enrollment().enrollmentRef,
        sourceWindowKey: enrollment().windowKey, effectiveAt: enrollment().windowStartsAt,
        expiresAt: enrollment().windowEndsAt,
      })],
    });
    expect(recordAcquisition).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      acquisitionRef: "00000000-0000-7000-8000-000000000102",
    }));
  });

  it("does not write an acquisition when the Credit account is unavailable", async () => {
    const recordAcquisition = vi.fn(async () => undefined);
    const service = new CreditProgramWindowService({
      repository: { claimDue: async () => [enrollment()], recordAcquisition },
      creditGrants: {
        prepareIssuance: async () => ({ kind: "unavailable", reason: "credit_account_suspended" }),
        issuePrepared: async () => { throw new Error("must not issue"); },
      },
      reference: () => "00000000-0000-7000-8000-000000000102",
    });
    await expect(service.issueDue({} as never)).resolves.toBe(0);
    expect(recordAcquisition).not.toHaveBeenCalled();
  });
});

function enrollment() {
  return Object.freeze({
    enrollmentRef: "00000000-0000-7000-8000-000000000100",
    siteId: "site-1", billingAccountId: "billing-1",
    creditProgramRevisionRef: "credit-program:daily:v1", creditProgramRevision: 1n,
    creditProgramRevisionDigest: "c".repeat(64), outputLineId: "daily-credit", outputOrdinal: 2,
    occurrence: 1, bucketClass: "daily" as const, unit: "credit", amount: "100",
    liabilityMerchantAccountId: "merchant-1", burnPriority: 10,
    scopePolicy: Object.freeze({ version: 1 as const, surfaceRefs: ["general.chat"],
      capabilityKeys: ["general.chat.message"], agentRefs: [], allowUnattributedAgent: true }),
    windowKey: "d".repeat(64), windowStartsAt: "2026-08-02T04:00:00.000Z",
    windowEndsAt: "2026-08-03T04:00:00.000Z", acquiredAt: "2026-08-02T12:00:00.000Z",
  });
}
