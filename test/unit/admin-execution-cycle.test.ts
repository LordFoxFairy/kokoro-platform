import { describe, expect, it } from "vitest";
import type { PlatformTransaction } from "../../src/shared/unit-of-work/index.js";
import { digestAdminValue } from
  "../../src/modules/admin-control/application/admin-digest.js";
import { createAdminExecutionCycle } from
  "../../src/modules/admin-control/application/admin-execution-cycle.js";

const transaction = Object.freeze({}) as PlatformTransaction;

describe("Admin execution worker cycle", () => {
  it("claims only admin execution events and opens the owner-axis transaction", async () => {
    const payload = {
      approvalRef: "approval_01", originatingCommandId: "command_01",
      ownerOperation: "site.suspend", makerRef: "maker_01", makerGeneration: "2",
      makerAuthorizationEpoch: "8", checkerRef: "checker_01", checkerGeneration: "4",
      checkerAuthorizationEpoch: "11", siteRef: "site_01", environment: "production",
      region: "us-east-1",
    };
    const event = {
      eventId: "event_0001", owner: "admin-execution",
      eventType: "admin.approval.execution.requested", aggregateId: "approval_01",
      payload, payloadDigest: digestAdminValue(payload), correlationId: "corr_01",
      causationId: "cause_01", leaseToken: "lease_0001", attempt: 1,
    } as const;
    const calls: unknown[] = [];
    const cycle = createAdminExecutionCycle({
      database: {
        async internalTransaction(operation, work) {
          calls.push(operation);
          return work(transaction);
        },
        async adminExecutionTransaction(fence, work) {
          calls.push(fence);
          return work(transaction);
        },
      },
      outbox: {
        async claim(_current, input) { calls.push(input); return [event]; },
        async retryOrDeadLetter() { throw new Error("not expected"); },
      },
      executor: { async executeClaim(current, claimed) { calls.push({ current, claimed }); } },
      workerId: "admin-worker-01",
      reference: () => "lease_0001",
    });

    await cycle({ signal: new AbortController().signal });

    expect(calls[0]).toBe("admin.execution.claim");
    expect(calls[1]).toMatchObject({ consumer: "admin-worker", workerId: "admin-worker-01",
      eventTypes: ["admin.approval.execution.requested"] });
    expect(calls[2]).toEqual({ operation: "site.suspend", siteRef: "site_01",
      environment: "production", region: "us-east-1", makerRef: "maker_01",
      makerGeneration: 2n, makerAuthorizationEpoch: 8n, checkerRef: "checker_01",
      checkerGeneration: 4n, checkerAuthorizationEpoch: 11n });
    expect(calls[3]).toEqual({ current: transaction, claimed: event });
  });
});
