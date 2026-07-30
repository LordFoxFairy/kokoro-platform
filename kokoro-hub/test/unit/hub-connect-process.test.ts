import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createHubConnectProcess } from "../../src/interfaces/connect/hub-connect-process.js";

describe("Hub Connect process lifecycle", () => {
  it("tracks a late draining session so the global deadline can destroy it", async () => {
    const server = new FakeServer({ closeHangs: true });
    const healthServer = new FakeServer();
    const session = new FakeSession(false);
    const process = createHubConnectProcess({
      server,
      healthServer,
      worker: { tick: vi.fn().mockResolvedValue("idle") },
      closeMongo: vi.fn().mockResolvedValue(undefined),
      port: 4252,
      healthPort: 4253,
      shutdownDeadlineMs: 25,
    });
    await process.start();

    const shutdown = process.shutdown();
    expect(process.isDraining()).toBe(true);
    server.emit("session", session);

    await expect(shutdown).rejects.toThrowError("HUB_CONNECT_SHUTDOWN_UNCONFIRMED");
    expect(session.close).toHaveBeenCalledOnce();
    expect(session.destroy).toHaveBeenCalledOnce();
    expect(session.listenerCount("close")).toBe(0);
  });

  it("turns an unexpected worker rejection into fatal draining without rescheduling", async () => {
    const server = new FakeServer();
    const healthServer = new FakeServer();
    const failure = new Error("projection repository unavailable");
    const tick = vi.fn().mockRejectedValue(failure);
    const closeMongo = vi.fn().mockResolvedValue(undefined);
    let drainingWhenFatal = false;
    const processReference: { current?: ReturnType<typeof createHubConnectProcess> } = {};
    const onFatal = vi.fn(() => {
      drainingWhenFatal = processReference.current?.isDraining() ?? false;
    });
    const process = createHubConnectProcess({
      server,
      healthServer,
      worker: { tick },
      closeMongo,
      port: 4252,
      healthPort: 4253,
      pollIntervalMs: 1,
      shutdownDeadlineMs: 100,
      onFatal,
    });
    processReference.current = process;
    await process.start();

    try {
      await vi.waitFor(() => expect(onFatal).toHaveBeenCalled());
      await vi.waitFor(() => expect(closeMongo).toHaveBeenCalledOnce());
      expect(onFatal).toHaveBeenCalledWith(failure);
      expect(drainingWhenFatal).toBe(true);
      expect(process.isDraining()).toBe(true);
      const callsAfterDrain = tick.mock.calls.length;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      expect(tick).toHaveBeenCalledTimes(callsAfterDrain);
    } finally {
      await process.shutdown().catch(() => undefined);
    }
  });

  it("continues the full cleanup stack when both session close and destroy throw", async () => {
    const server = new FakeServer();
    const healthServer = new FakeServer();
    const closeMongo = vi.fn().mockResolvedValue(undefined);
    const session = new FakeSession(false, { closeThrows: true, destroyThrows: true });
    const process = createHubConnectProcess({
      server,
      healthServer,
      worker: { tick: vi.fn().mockResolvedValue("idle") },
      closeMongo,
      port: 4252,
      healthPort: 4253,
      shutdownDeadlineMs: 100,
    });
    await process.start();
    server.emit("session", session);

    await expect(process.shutdown()).rejects.toThrowError("HUB_CONNECT_SHUTDOWN_UNCONFIRMED");

    expect(session.close).toHaveBeenCalledOnce();
    expect(session.destroy).toHaveBeenCalledOnce();
    expect(server.close).toHaveBeenCalledOnce();
    expect(healthServer.close).toHaveBeenCalledOnce();
    expect(closeMongo).toHaveBeenCalledOnce();
  });

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
    if (this.behavior.closeThrows) throw new Error("session close failed");
    if (this.closeNaturally) queueMicrotask(() => this.emit("close"));
  });
  readonly destroy = vi.fn(() => {
    if (this.behavior.destroyThrows) throw new Error("session destroy failed");
    this.emit("close");
  });

  constructor(
    private readonly closeNaturally: boolean,
    private readonly behavior: Readonly<{
      closeThrows?: boolean;
      destroyThrows?: boolean;
    }> = {},
  ) {
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
