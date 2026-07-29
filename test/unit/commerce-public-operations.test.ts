import { describe, expect, it } from "vitest";
import {
  COMMERCE_PUBLIC_OPERATION_IDS,
  createCommercePublicOperations,
} from "../../src/modules/commerce/interfaces/http/commerce-public-operations.js";

describe("Commerce public operations", () => {
  it("registers preview and confirm and maps only their generated wire inputs", async () => {
    const calls: unknown[] = [];
    const operations = createCommercePublicOperations({
      preview: { execute: async (input) => { calls.push({ preview: input }); return { preview: true } as never; } },
      confirm: { execute: async (input) => { calls.push({ confirm: input }); return { kind: "rejected" } as never; } },
      queries: {
        recoverCommand: async (input) => { calls.push({ recover: input }); return { kind: "executing" } as never; },
        getReceipt: async (input) => { calls.push({ receipt: input }); return { redemption: true } as never; },
      },
      accountQueries: {
        getCreditGrant: async (input) => { calls.push({ creditGrant: input }); return { grant: true } as never; },
        getCreditSummary: async (input) => { calls.push({ creditSummary: input }); return { units: [] } as never; },
        getUsageDetail: async (input) => { calls.push({ usage: input }); return { usage: true } as never; },
        listAccountProducts: async (input) => { calls.push({ products: input }); return { products: [] } as never; },
      },
    });
    expect(COMMERCE_PUBLIC_OPERATION_IDS).toEqual([
      "previewRedemption", "confirmRedemption", "recoverRedemptionCommand", "getRedemptionReceipt",
      "getCreditGrant", "getCreditSummary", "getUsageDetail", "listAccountProducts",
    ]);
    expect(operations.map((operation) => operation.operationId)).toEqual(COMMERCE_PUBLIC_OPERATION_IDS);
    const confirm = operations.find((operation) => operation.operationId === "confirmRedemption")!;
    expect(confirm.successStatus?.({ kind: "accepted" })).toBe(202);
    expect(confirm.successStatus?.({ kind: "executing" })).toBe(202);
    expect(confirm.successStatus?.({ kind: "outcome_unknown" })).toBe(202);
    expect(confirm.successStatus?.({ kind: "succeeded" })).toBe(200);
    await confirm.execute({
      context: { context: true },
      headers: {
        "X-Kokoro-Command-Id": "00000000-0000-7000-8000-000000000201",
        "Idempotency-Key": "confirm-1",
      },
      body: { previewCredential: "opaque-preview", legalAcceptanceRefs: ["terms-v1"] },
    } as never);
    expect(calls).toEqual([{ confirm: {
      context: { context: true },
      commandId: "00000000-0000-7000-8000-000000000201",
      idempotencyKey: "confirm-1",
      previewCredential: "opaque-preview",
      legalAcceptanceRefs: ["terms-v1"],
    } }]);
  });
});
