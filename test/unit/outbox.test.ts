import { describe, expect, it } from "vitest";
import { OutboxRepository } from "../../src/shared/outbox-inbox/outbox.js";
import { issuePlatformTransaction, revokePlatformTransaction } from "../../src/shared/unit-of-work/platform-transaction.js";

describe("outbox retry bounds", () => {
  it("rejects invalid retry input before touching persistence", async () => {
    const lease = issuePlatformTransaction({ query: async () => [], execute: async () => { throw new Error("SQL_MUST_NOT_RUN"); } });
    try {
      await expect(new OutboxRepository().retryOrDeadLetter(lease.transaction, { eventId: "event", leaseToken: "lease", errorCode: "", retryAt: "invalid", maxAttempts: 0 })).rejects.toThrow("OUTBOX_RETRY_INPUT_INVALID");
    } finally { revokePlatformTransaction(lease); }
  });
});
