import { describe, expect, it } from "vitest";
import { runPlatformWorkerActivities } from "../../src/process/worker.js";

describe("Platform Worker activity isolation", () => {
  it("runs every capability even when an unrelated activity fails", async () => {
    const calls: string[] = [];
    const context = { signal: new AbortController().signal };
    const result = runPlatformWorkerActivities(context, [
      async () => { calls.push("retention"); throw new Error("retention failed"); },
      async () => { calls.push("terminalizer"); },
      async () => { calls.push("admin-execution"); },
    ]);
    await expect(result).rejects.toThrow("PLATFORM_WORKER_CYCLE_FAILED");
    expect(calls).toEqual(["retention", "terminalizer", "admin-execution"]);
  });
});
