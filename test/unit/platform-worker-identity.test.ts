import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import * as workerModule from "../../src/process/worker.js";

describe("Platform worker instance identity", () => {
  it("requires one explicit stable instance identity and rejects invalid values", () => {
    const loader = (workerModule as unknown as {
      loadPlatformWorkerId?: (
        environment: Readonly<Record<string, string | undefined>>,
      ) => string;
    }).loadPlatformWorkerId;
    expect(loader).toBeTypeOf("function");
    if (loader === undefined) return;
    expect(() => loader({})).toThrow("PLATFORM_WORKER_ID_REQUIRED");
    expect(() => loader({ PLATFORM_WORKER_ID: "same worker\n" }))
      .toThrow("PLATFORM_WORKER_ID_INVALID");
    expect(loader({ PLATFORM_WORKER_ID: "6a2b7318-0a14-4b22-a52f-2e4e44fbb75e" }))
      .toBe("6a2b7318-0a14-4b22-a52f-2e4e44fbb75e");
  });

  it("injects a unique Kubernetes Pod UID and an explicit Compose identity", async () => {
    const [kubernetes, compose, worker] = await Promise.all([
      readFile("deploy/k8s/platform-services.example.yaml", "utf8"),
      readFile("deploy/docker-compose.services.yml", "utf8"),
      readFile("src/process/worker.ts", "utf8"),
    ]);
    expect(kubernetes).toMatch(
      /name: PLATFORM_WORKER_ID[\s\S]+fieldRef: \{ fieldPath: metadata\.uid \}/u,
    );
    expect(compose).toContain("PLATFORM_WORKER_ID: ${PLATFORM_WORKER_ID:?required}");
    expect(worker).not.toContain("platform-worker-${process.pid}");
  });
});
