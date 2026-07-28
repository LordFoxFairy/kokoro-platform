import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModuleConfig } from "../../src/config.js";
import { createAdminServer, type AdminServerDeps } from "../../src/server.js";
import type { Operator } from "../../src/rbac.js";

const modules: ModuleConfig[] = [
  {
    id: "site",
    label: "Sites",
    baseUrl: "http://kokoro-site:4201",
    manifestPath: "/admin/sites/manifest",
  },
];
const reader: Operator = {
  id: "operator-docs",
  email: "docs@example.test",
  roleKey: "ops",
  permissions: ["docs.read"],
  scopeSites: ["*"],
};
const fetchMock = vi.fn<typeof fetch>();

function trackedResponse(
  body: string,
  init: ResponseInit & { close?: boolean } = {},
): { cancel: ReturnType<typeof vi.fn>; response: Response } {
  const cancel = vi.fn();
  const { close = false, ...responseInit } = init;
  const bytes = new TextEncoder().encode(body);
  return {
    cancel,
    response: new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          if (close) controller.close();
        },
        cancel,
      }),
      responseInit,
    ),
  };
}

function deps(operator: Operator = reader): AdminServerDeps {
  return {
    audit: { record: async () => {} },
    resolveOperator: async () => operator,
    authenticate: async () => operator.email,
    prisma: {} as AdminServerDeps["prisma"],
    approvalGrantThresholdMicros: 100_000_000n,
    internalSecret: "admin-secret",
    openApi: { timeoutMs: 20, maxBytes: 1024 },
  } as AdminServerDeps;
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => vi.unstubAllGlobals());

describe("GET /api/openapi/:moduleId", () => {
  it("returns a known module contract through the authenticated same-origin gateway", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ openapi: "3.0.3", paths: {} }), {
        headers: { "content-type": "application/json" },
      }),
    );
    const app = createAdminServer(modules, deps());

    const response = await app.inject({ method: "GET", url: "/api/openapi/site" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^application\/json/u);
    expect(response.headers["content-disposition"]).toBe('inline; filename="site-openapi.json"');
    expect(response.json()).toEqual({ openapi: "3.0.3", paths: {} });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://kokoro-site:4201/docs/json");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      redirect: "error",
      headers: {
        "x-kokoro-service": "admin",
        "x-kokoro-internal-secret": "admin-secret",
      },
    });
  });

  it("rejects unknown module ids before fetch", async () => {
    const app = createAdminServer(modules, deps());
    const response = await app.inject({ method: "GET", url: "/api/openapi/unknown" });
    expect(response.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires explicit docs.read authorization", async () => {
    const app = createAdminServer(modules, deps({ ...reader, permissions: ["site.read"] }));
    const response = await app.inject({ method: "GET", url: "/api/openapi/site" });
    expect(response.statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["non-2xx", () => trackedResponse("{}", { status: 503, headers: { "content-type": "application/json" } })],
    ["non-JSON", () => trackedResponse("<html></html>", { headers: { "content-type": "text/html" } })],
    [
      "invalid declared length",
      () => trackedResponse("{}", { headers: { "content-type": "application/json", "content-length": "invalid" } }),
    ],
    [
      "declared oversized",
      () => trackedResponse("{}", { headers: { "content-type": "application/json", "content-length": "2048" } }),
    ],
    [
      "actual oversized",
      () => trackedResponse(JSON.stringify({ value: "x".repeat(2048) }), { headers: { "content-type": "application/json" } }),
    ],
  ] as const)("fails closed and cancels the body for %s upstream contracts", async (_name, createUpstream) => {
    const upstream = createUpstream();
    let signal: AbortSignal | null | undefined;
    fetchMock.mockImplementation(async (_input, init) => {
      signal = init?.signal;
      return upstream.response;
    });
    const app = createAdminServer(modules, deps());
    const response = await app.inject({ method: "GET", url: "/api/openapi/site" });
    expect(response.statusCode).toBe(502);
    expect(signal?.aborted).toBe(true);
    expect(upstream.cancel).toHaveBeenCalledTimes(1);
  });

  it("aborts and cancels a slow never-ending upstream body", async () => {
    const cancel = vi.fn();
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const upstream = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"openapi":"3.0.3"'));
          closeTimer = setTimeout(() => controller.close(), 100);
        },
        cancel() {
          if (closeTimer !== undefined) clearTimeout(closeTimer);
          cancel();
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
    let signal: AbortSignal | null | undefined;
    fetchMock.mockImplementation(async (_input, init) => {
      signal = init?.signal;
      return upstream;
    });
    const app = createAdminServer(modules, deps());
    const response = await app.inject({ method: "GET", url: "/api/openapi/site" });
    expect(response.statusCode).toBe(504);
    expect(signal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
