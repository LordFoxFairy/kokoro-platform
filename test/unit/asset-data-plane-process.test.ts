import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { PlatformDatabaseClient } from "../../src/infrastructure/postgres/client.js";
import type { AssetDataPlaneProductionComposition } from
  "../../src/process/asset-data-plane-composition.js";
import { createAssetDataPlaneProcess } from "../../src/process/asset-data-plane.js";

class FakeSecureServer extends EventEmitter {
  readonly close = vi.fn((callback?: () => void) => callback?.());
  readonly closeIdleConnections = vi.fn();
  readonly closeAllConnections = vi.fn();
  readonly listen = vi.fn((_port: number, _host: string, callback?: () => void) => callback?.());
  address() { return { address: "127.0.0.1", family: "IPv4", port: 4246 }; }
}

describe("Asset data-plane process", () => {
  it("starts after database readiness and drains HTTPS before disconnecting", async () => {
    const events: string[] = [];
    const database = fakeDatabase(events);
    const server = new FakeSecureServer();
    let listener: ((request: IncomingMessage, response: ServerResponse) => void) | undefined;
    const composition: AssetDataPlaneProductionComposition = {
      handler: { handle: vi.fn(async () => true) },
      createServer(received) {
        listener = received;
        events.push("server.create");
        return server as never;
      },
    };
    const process = createAssetDataPlaneProcess({ database, composition });

    await expect(process.start({ host: "127.0.0.1", port: 4246 })).resolves.toBe(
      "https://127.0.0.1:4246",
    );
    expect(process.status()).toEqual({
      state: "running", live: true, ready: true, draining: false,
    });
    expect(events).toEqual(["db.connect", "db.ready", "server.create"]);
    expect(listener).toBeTypeOf("function");

    await process.shutdown();
    expect(server.closeIdleConnections).toHaveBeenCalledOnce();
    expect(server.close).toHaveBeenCalledOnce();
    expect(events.at(-1)).toBe("db.disconnect");
    expect(process.status()).toEqual({
      state: "stopped", live: false, ready: false, draining: false,
    });
  });

  it("disconnects without binding when database readiness fails", async () => {
    const events: string[] = [];
    const database = fakeDatabase(events);
    vi.mocked(database.checkHealth).mockRejectedValueOnce(new Error("database unavailable"));
    const composition: AssetDataPlaneProductionComposition = {
      handler: { handle: vi.fn(async () => true) },
      createServer: vi.fn(() => new FakeSecureServer() as never),
    };
    const process = createAssetDataPlaneProcess({ database, composition });

    await expect(process.start()).rejects.toThrow("database unavailable");
    expect(composition.createServer).not.toHaveBeenCalled();
    expect(events).toEqual(["db.connect", "db.disconnect"]);
    expect(process.status().state).toBe("stopped");
  });

  it("never reports ready when a health probe completes after drain begins", async () => {
    const events: string[] = [];
    const database = fakeDatabase(events);
    let resolveProbe: (() => void) | undefined;
    const probe = new Promise<void>((resolve) => { resolveProbe = resolve; });
    vi.mocked(database.checkHealth)
      .mockResolvedValueOnce()
      .mockImplementationOnce(() => probe);
    const server = new FakeSecureServer();
    let listener: ((request: IncomingMessage, response: ServerResponse) => void) | undefined;
    const composition: AssetDataPlaneProductionComposition = {
      handler: { handle: vi.fn(async () => true) },
      createServer(received) {
        listener = received;
        return server as never;
      },
    };
    const process = createAssetDataPlaneProcess({ database, composition });
    await process.start({ host: "127.0.0.1", port: 4246 });
    const response = new ProbeResponse();

    listener!(
      { method: "GET", url: "/health/ready" } as IncomingMessage,
      response.value,
    );
    await process.shutdown();
    resolveProbe!();
    await response.ended;

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "not_ready" });
  });
});

function fakeDatabase(events: string[]): PlatformDatabaseClient {
  return {
    connect: vi.fn(async () => { events.push("db.connect"); }),
    checkHealth: vi.fn(async () => { events.push("db.ready"); }),
    disconnect: vi.fn(async () => { events.push("db.disconnect"); }),
  };
}

class ProbeResponse {
  readonly headers = new Map<string, string>();
  readonly ended: Promise<void>;
  readonly value: ServerResponse;
  body = "";
  private resolveEnd: (() => void) | undefined;

  constructor() {
    this.ended = new Promise((resolve) => { this.resolveEnd = resolve; });
    this.value = {
      statusCode: 200,
      destroyed: false,
      setHeader: (name: string, value: string | number | readonly string[]) => {
        this.headers.set(name.toLowerCase(), Array.isArray(value) ? value.join(", ") : String(value));
        return this.value;
      },
      end: (body?: string | Buffer) => {
        this.body = body === undefined ? "" : body.toString();
        this.resolveEnd?.();
        return this.value;
      },
    } as unknown as ServerResponse;
  }

  get statusCode(): number {
    return this.value.statusCode;
  }

  json(): unknown {
    return JSON.parse(this.body) as unknown;
  }
}
