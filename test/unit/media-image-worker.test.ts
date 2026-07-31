import { describe, expect, it, vi } from "vitest";
import {
  ImageOperationWorker,
  InMemoryMediaImageWorkerRepository,
  type MediaImageCreditSettlementPort,
  type MediaImageSessionProjectionPort,
  type MediaImageUsagePort,
} from "../../src/modules/media/application/image-operation-worker.js";
import { DeterministicDevelopmentImageProviderAdapter } from
  "../../src/modules/media/infrastructure/dev/deterministic-image-provider.js";
import { artifactPort, receiptPort } from "./helpers/media-image-worker-fakes.js";

describe("image.text_to_image worker closure", () => {
  it("commits the owner journal before Gateway Create and closes from owner receipts", async () => {
    const events: string[] = [];
    const repository = new InMemoryMediaImageWorkerRepository(undefined, events);
    const effect = new DeterministicDevelopmentImageProviderAdapter(events);
    const artifact = artifactPort(events);
    const usage: MediaImageUsagePort = { recordAttempt: vi.fn(async () => {
      events.push("usage"); return { attemptUsageEvidenceReceiptRef: "usage-receipt:one" };
    }) };
    const credit: MediaImageCreditSettlementPort = {
      releaseChild: vi.fn(async () => ({ allocationReturnReceiptRef: "return:released" })),
      returnChild: vi.fn(async () => { events.push("credit.return");
        return { allocationReturnReceiptRef: "return:one" }; }),
    };
    const projection: MediaImageSessionProjectionPort = { publish: vi.fn(async () => {
      events.push("projection"); return { projectionReceiptRef: "projection-receipt:one" };
    }) };
    const worker = new ImageOperationWorker({ repository, effect, artifact, receipts: receiptPort(),
      trust: { evaluate: vi.fn(async (input) => { events.push("trust");
        return { kind: "allow" as const, decisionRef: "trust:one", contentSha256: input.contentSha256 }; }) },
      usage, credit, projection, clock: () => new Date("2026-07-31T12:00:00.000Z"),
      workerId: "worker:one" });

    expect(await worker.runOne(new AbortController().signal)).toBe("completed");
    expect(repository.inspectTerminal()?.receipts).toMatchObject({
      effectBudgetCommitRef: "effect-budget-commit:example",
      usageEvidenceReceiptRef: "usage-receipt:one",
      allocationReturnReceiptRef: "return:one",
      projectionReceiptRef: "projection-receipt:one",
    });
    expect(events.indexOf("effect.prepare")).toBeLessThan(events.indexOf("gateway.create"));
    expect(events).toContain("trust.record");
    expect(events).toContain("usage.record");
    expect(await worker.runOne(new AbortController().signal)).toBe("idle");
    expect(effect.invocationCount).toBe(1);
  });

});
