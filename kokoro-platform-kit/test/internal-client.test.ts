import { z } from "zod";
import { describe, expect, it } from "vitest";
import { callService } from "../src/http/internal-client.js";
import type { RequestContext } from "../src/http/request-context.js";
import { AppError } from "../src/domain/errors.js";

const ctx: RequestContext = {
  requestId: "req-1",
  siteId: "site-x",
  principal: { kind: "system" },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("callService", () => {
  it("returns schema-validated data and transmits context + caller + internal secret headers", async () => {
    let capturedUrl = "";
    let capturedHeaders = new Headers();
    const fetchImpl: typeof fetch = async (url, init) => {
      capturedUrl = String(url);
      capturedHeaders = new Headers(init?.headers);
      return jsonResponse({ data: { ok: true } });
    };
    const out = await callService(ctx, {
      baseUrl: "http://svc",
      method: "GET",
      path: "/x",
      schema: z.object({ ok: z.boolean() }),
      caller: "payment",
      internalSecret: "s3cr3t",
      fetchImpl,
    });
    expect(out).toEqual({ ok: true });
    expect(capturedUrl).toBe("http://svc/x");
    expect(capturedHeaders.get("x-kokoro-request-id")).toBe("req-1");
    expect(capturedHeaders.get("x-kokoro-site-id")).toBe("site-x");
    expect(capturedHeaders.get("x-kokoro-internal-secret")).toBe("s3cr3t");
    // caller 头必发：下游 route-access 缺它即 401，漏发等于整条链路恒红。
    expect(capturedHeaders.get("x-kokoro-service")).toBe("payment");
  });

  it.each([
    ["http://svc/", "/x", "http://svc/x"],
    ["http://svc/api", "x", "http://svc/api/x"],
  ])("normalizes baseUrl %s and path %s", async (baseUrl, path, expectedUrl) => {
    let capturedUrl = "";
    const fetchImpl: typeof fetch = async (url) => {
      capturedUrl = String(url);
      return jsonResponse({ data: { ok: true } });
    };
    await callService(ctx, {
      baseUrl,
      method: "GET",
      path,
      schema: z.object({ ok: z.boolean() }),
      caller: "payment",
      fetchImpl,
    });
    expect(capturedUrl).toBe(expectedUrl);
  });

  it("serializes a POST body with content-type", async () => {
    let capturedBody = "";
    let contentType: string | null = null;
    const fetchImpl: typeof fetch = async (_url, init) => {
      capturedBody = String(init?.body ?? "");
      contentType = new Headers(init?.headers).get("content-type");
      return jsonResponse({ data: { id: "1" } });
    };
    await callService(ctx, {
      baseUrl: "http://svc",
      method: "POST",
      path: "/create",
      body: { name: "a" },
      schema: z.object({ id: z.string() }),
      caller: "payment",
      fetchImpl,
    });
    expect(JSON.parse(capturedBody)).toEqual({ name: "a" });
    expect(contentType).toBe("application/json");
  });

  it("maps a non-2xx error envelope to AppError(code,status)", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({ error: { code: "credit.insufficient", message: "no balance", details: { need: "500" } } }, 402);
    const error = await callService(ctx, {
      baseUrl: "http://svc",
      method: "GET",
      path: "/x",
      schema: z.object({}),
      caller: "payment",
      fetchImpl,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: "credit.insufficient",
      httpStatus: 402,
      details: { need: "500" },
    });
  });

  it("validates successful data with the provided schema", async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({ data: { ok: "yes" } });
    await expect(
      callService(ctx, {
        baseUrl: "http://svc",
        method: "GET",
        path: "/x",
        schema: z.object({ ok: z.boolean() }),
        caller: "payment",
        fetchImpl,
      }),
    ).rejects.toThrow();
  });

  it("maps a network failure to AppError upstream.unreachable 502", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const err = await callService(ctx, {
      baseUrl: "http://svc",
      method: "GET",
      path: "/x",
      schema: z.object({}),
      caller: "payment",
      fetchImpl,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("upstream.unreachable");
    expect((err as AppError).httpStatus).toBe(502);
  });
});
