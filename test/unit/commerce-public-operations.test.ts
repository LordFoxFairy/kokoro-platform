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
    });
    expect(COMMERCE_PUBLIC_OPERATION_IDS).toEqual(["previewRedemption", "confirmRedemption"]);
    expect(operations.map((operation) => operation.operationId)).toEqual(COMMERCE_PUBLIC_OPERATION_IDS);
    const confirm = operations.find((operation) => operation.operationId === "confirmRedemption")!;
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
