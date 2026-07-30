import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createHubConnectProcess } from "../../src/interfaces/connect/hub-connect-process.js";

describe("Hub Connect process lifecycle", () => {
  it("marks readiness draining and sends GOAWAY before closing dependencies", async () => {
    const server = new FakeServer();
    const healthServer = new FakeServer();
    const session = new FakeSession(true);
    const closeMongo = vi.fn().mockResolvedValue(undefined);
    const process = createHubConnectProcess({
      server,
      healthServer,
      worker: { tick: vi.fn().mockResolvedValue("idle") },
      closeMongo,
      port: 4252,
      healthPort: 4253,
      pollIntervalMs: 60_000,
      shutdownDeadlineMs: 100,
    });
    await process.start();
    server.emit("session", session);

    await process.shutdown();

    expect(process.isDraining()).toBe(true);
    expect(session.close).toHaveBeenCalledOnce();
    expect(session.destroy).not.toHaveBeenCalled();
    expect(server.close).toHaveBeenCalledOnce();
    expect(healthServer.close).toHaveBeenCalledOnce();
    expect(closeMongo).toHaveBeenCalledOnce();
  });

  it("destroys hung sessions and still closes health and Mongo within the deadline", async () => {
    const server = new FakeServer({ closeHangs: true });
    const healthServer = new FakeServer();
    const session = new FakeSession(false);
    const closeMongo = vi.fn().mockResolvedValue(undefined);
    const tick = vi.fn().mockReturnValue(new Promise(() => undefined));
    const process = createHubConnectProcess({
      server,
      healthServer,
      worker: { tick },
      closeMongo,
      port: 4252,
      healthPort: 4253,
      pollIntervalMs: 1,
      shutdownDeadlineMs: 25,
    });
    await process.start();
    server.emit("session", session);
    await vi.waitFor(() => expect(tick).toHaveBeenCalledOnce());

    await expect(process.shutdown()).rejects.toThrowError("HUB_CONNECT_SHUTDOWN_UNCONFIRMED");

    expect(session.close).toHaveBeenCalledOnce();
    expect(session.destroy).toHaveBeenCalledOnce();
    expect(healthServer.close).toHaveBeenCalledOnce();
    expect(closeMongo).toHaveBeenCalledOnce();
  });

  it("uses the same cleanup stack when the health listener fails after Connect starts", async () => {
    const server = new FakeServer();
    const healthServer = new FakeServer({ listenError: new Error("health bind failed") });
    const closeMongo = vi.fn().mockResolvedValue(undefined);
    const process = createHubConnectProcess({
      server,
      healthServer,
      worker: { tick: vi.fn().mockResolvedValue("idle") },
      closeMongo,
      port: 4252,
      healthPort: 4253,
      shutdownDeadlineMs: 100,
    });

    await expect(process.start()).rejects.toThrowError("health bind failed");

    expect(process.isDraining()).toBe(true);
    expect(server.close).toHaveBeenCalledOnce();
    expect(healthServer.close).toHaveBeenCalledOnce();
    expect(closeMongo).toHaveBeenCalledOnce();
  });
});

class FakeSession extends EventEmitter {
  readonly close = vi.fn(() => {
    if (this.closeNaturally) queueMicrotask(() => this.emit("close"));
  });
  readonly destroy = vi.fn(() => this.emit("close"));

  constructor(private readonly closeNaturally: boolean) {
    super();
  }
}

class FakeServer extends EventEmitter {
  readonly close = vi.fn((callback: (error?: Error) => void) => {
    if (!this.behavior.closeHangs) queueMicrotask(() => callback());
    return this;
  });
  readonly listen = vi.fn((_port: number, _host: string, callback: () => void) => {
    if (this.behavior.listenError !== undefined) {
      queueMicrotask(() => this.emit("error", this.behavior.listenError));
    } else {
      queueMicrotask(callback);
    }
    return this;
  });

  constructor(private readonly behavior: Readonly<{
    closeHangs?: boolean;
    listenError?: Error;
  }> = {}) {
    super();
  }
}
