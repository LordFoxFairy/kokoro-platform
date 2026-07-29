import { describe, expect, it } from "vitest";
import type { PlatformTransaction } from "../../src/shared/unit-of-work/index.js";
import { createAdminTerminalizerCycle } from
  "../../src/modules/admin-control/application/admin-terminalizer.js";

const transaction = Object.freeze({}) as PlatformTransaction;

describe("Admin terminalizer", () => {
  it("terminalizes stale/expired approvals and overdue break-glass reviews in one worker transaction", async () => {
    const calls: unknown[] = [];
    const cycle = createAdminTerminalizerCycle({
      database: {
        async internalTransaction(operation, work) {
          calls.push(operation);
          return work(transaction);
        },
      },
      repository: {
        async terminalizeApprovals(current, now) {
          calls.push({ current, now, approvals: true });
          return 2;
        },
        async terminalizePostEffectReviews(current, now) {
          calls.push({ current, now, reviews: true });
          return 1;
        },
      },
      clock: () => new Date("2026-07-29T12:00:00.000Z"),
    });

    await cycle({ signal: new AbortController().signal });

    expect(calls).toEqual([
      "admin.terminalize",
      { current: transaction, now: "2026-07-29T12:00:00.000Z", approvals: true },
      { current: transaction, now: "2026-07-29T12:00:00.000Z", reviews: true },
    ]);
  });

  it("honors shutdown before opening a transaction", async () => {
    const controller = new AbortController();
    controller.abort();
    const cycle = createAdminTerminalizerCycle({
      database: { async internalTransaction() { throw new Error("should not run"); } },
      repository: {
        async terminalizeApprovals() { return 0; },
        async terminalizePostEffectReviews() { return 0; },
      },
    });
    await expect(cycle({ signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});
