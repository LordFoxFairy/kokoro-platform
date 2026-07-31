import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { createArtifactDataPlaneProcess } from "../../src/process/artifact-data-plane.js";

describe("Artifact data-plane process", () => {
  it("checks its owner runtime before readiness and drains it after the listener", async () => {
    const events: string[] = [];
    const server = new ServerDouble(events, "secure");
    const health = new ServerDouble(events, "health");
    const database = {
      connect: vi.fn(async () => { events.push("database.connect"); }),
      checkHealth: vi.fn(async () => { events.push("database.ready"); }),
      disconnect: vi.fn(async () => { events.push("database.close"); }),
    };
    const process = createArtifactDataPlaneProcess({
      database,
      composition: {
        handler: { handle: vi.fn(async () => true) },
        checkHealth: vi.fn(async () => { events.push("runtime.ready"); }),
        close: vi.fn(async () => { events.push("runtime.close"); }),
        createServer: () => server as never,
      },
      healthServerFactory: () => health as never,
    });

    await expect(process.start({ host: "127.0.0.1", port: 4248 }))
      .resolves.toBe("https://127.0.0.1:4248");
    expect(process.status()).toMatchObject({ state: "running", ready: true });
    await process.shutdown();
    expect(events).toEqual(["database.connect", "database.ready", "runtime.ready", "health.listen", "secure.listen",
      "secure.closeIdle", "health.closeIdle", "secure.close", "health.close", "runtime.close", "database.close"]);
  });
});

class ServerDouble extends EventEmitter {
  constructor(private readonly events: string[], private readonly name: string) { super(); }
  listen(_port: number, _host: string, callback: () => void): this {
    this.events.push(`${this.name}.listen`); callback(); return this;
  }
  address(): AddressInfo { return { address: "127.0.0.1", family: "IPv4", port: 4248 }; }
  close(callback: () => void): this { this.events.push(`${this.name}.close`); callback(); return this; }
  closeIdleConnections(): void { this.events.push(`${this.name}.closeIdle`); }
  closeAllConnections(): void { this.events.push(`${this.name}.closeAll`); }
}
