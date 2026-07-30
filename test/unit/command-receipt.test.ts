import { describe, expect, it } from "vitest";
import { CommandReceiptRepository, type CommandIdentity } from
  "../../src/shared/outbox-inbox/receipt.js";
import {
  issuePlatformTransaction,
  revokePlatformTransaction,
} from "../../src/shared/unit-of-work/platform-transaction.js";

const incoming: CommandIdentity = Object.freeze({
  commandId: "018f1212-1212-7212-8212-121212121212",
  environment: "production",
  region: "us-east-1",
  callerIdentity: "spiffe://kokoro/web-admin",
  operation: "model.inventory.activate",
  idempotencyKey: "inventory-activation-0001",
  requestDigest: "a".repeat(64),
});

describe("CommandReceiptRepository", () => {
  it("rejects command-id drift even when the idempotency key and digest match", async () => {
    const lease = issuePlatformTransaction({
      execute: async () => 0,
      query: async <Row extends Record<string, unknown>>() => [{
        ...incoming,
        commandId: "018f1313-1313-7313-8313-131313131313",
        state: "succeeded",
        result: { ok: true },
        resultDigest: "b".repeat(64),
      }] as unknown as readonly Row[],
    });
    try {
      await expect(new CommandReceiptRepository().begin(lease.transaction, incoming))
        .rejects.toThrow("COMMAND_IDENTITY_CONFLICT");
    } finally {
      revokePlatformTransaction(lease);
    }
  });
});
