import { describe, expect, it } from "vitest";
import type { PlatformWorkerProcessStatus } from "../../src/process/worker.js";
import {
  createPlatformWorkerHealthServer,
  loadPlatformWorkerHealthPort,
} from "../../src/process/worker-health-server.js";

describe("Platform worker health surface", () => {
  it("projects live, ready, and draining state without exposing operational data", async () => {
    let status: PlatformWorkerProcessStatus = {
      state: "starting",
      live: false,
      ready: false,
      draining: false,
    };
    const health = createPlatformWorkerHealthServer({
      status: () => status,
      host: "127.0.0.1",
      port: 0,
    });
    const address = await health.start();
    try {
      expect(await fetch(`${address}/health/live`).then((response) => response.status)).toBe(503);
      status = { state: "running", live: true, ready: true, draining: false };
      const ready = await fetch(`${address}/health/ready`);
      expect(ready.status).toBe(200);
      expect(await ready.json()).toEqual({ status: "ok", state: "running", draining: false });
      status = { state: "draining", live: true, ready: false, draining: true };
      expect(await fetch(`${address}/health/live`).then((response) => response.status)).toBe(200);
      expect(await fetch(`${address}/health/ready`).then((response) => response.status)).toBe(503);
      expect(await fetch(`${address}/metrics`).then((response) => response.status)).toBe(404);
      expect(await fetch(`${address}/health/live`, { method: "POST" })
        .then((response) => response.status)).toBe(405);
    } finally {
      await health.close();
    }
  });

  it("uses one bounded health port contract for every worker deployable", () => {
    expect(loadPlatformWorkerHealthPort({})).toBe(4190);
    expect(loadPlatformWorkerHealthPort({ PLATFORM_WORKER_HEALTH_PORT: "4219" })).toBe(4219);
    for (const value of ["0", "65536", "-1", "4.2", ""] as const) {
      expect(() => loadPlatformWorkerHealthPort({ PLATFORM_WORKER_HEALTH_PORT: value }))
        .toThrow("PLATFORM_WORKER_HEALTH_PORT_INVALID");
    }
  });
});
