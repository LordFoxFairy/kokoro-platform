import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { PlatformDatabaseClient } from "../../src/infrastructure/postgres/client.js";
import type {
  AdmissionProductionComposition,
  AdmissionRequestListener,
} from "../../src/process/admission-composition.js";
import { createPlatformAdmissionProcess } from "../../src/process/admission.js";

class FakeSecureServer extends EventEmitter {
  readonly close = vi.fn((callback?: () => void) => callback?.());
  readonly listen = vi.fn((_port: number, _host: string, callback?: () => void) => callback?.());
  address() { return { address: "127.0.0.1", family: "IPv4", port: 4244 }; }
}

function database(events: string[]): PlatformDatabaseClient {
  return {
    connect: vi.fn(async () => { events.push("db.connect"); }),
    checkHealth: vi.fn(async () => { events.push("db.ready"); }),
    disconnect: vi.fn(async () => { events.push("db.disconnect"); }),
  };
}

describe("Platform Admission process", () => {
  it("starts only after database readiness and drains the server before disconnecting", async () => {
    const events: string[] = [];
    const db = database(events);
    const server = new FakeSecureServer();
    const composition: AdmissionProductionComposition = {
      handler: vi.fn(),
      createServer(listener: AdmissionRequestListener) {
        expect(typeof listener).toBe("function");
        events.push("server.create");
        return server as never;
      },
    };
    const process = createPlatformAdmissionProcess({ database: db, composition });

    await expect(process.start({ host: "127.0.0.1", port: 4244 })).resolves.toBe(
      "https://127.0.0.1:4244",
    );
    expect(process.status()).toEqual({
      state: "running", live: true, ready: true, draining: false,
    });
    expect(events).toEqual(["db.connect", "db.ready", "server.create"]);

    await process.shutdown();
    expect(server.close).toHaveBeenCalledOnce();
    expect(events.at(-1)).toBe("db.disconnect");
    expect(process.status()).toEqual({
      state: "stopped", live: false, ready: false, draining: false,
    });
  });

  it("disconnects and returns to stopped when readiness fails before listen", async () => {
    const events: string[] = [];
    const db = database(events);
    vi.mocked(db.checkHealth).mockRejectedValueOnce(new Error("database unavailable"));
    const composition: AdmissionProductionComposition = {
      handler: vi.fn(),
      createServer: vi.fn(() => new FakeSecureServer() as never),
    };
    const process = createPlatformAdmissionProcess({ database: db, composition });

    await expect(process.start()).rejects.toThrow("database unavailable");
    expect(composition.createServer).not.toHaveBeenCalled();
    expect(events).toEqual(["db.connect", "db.disconnect"]);
    expect(process.status().state).toBe("stopped");
  });
});
