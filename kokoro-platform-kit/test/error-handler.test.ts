import Fastify from "fastify";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { registerErrorHandler } from "../src/http/error-handler.js";
import { AppError } from "../src/domain/errors.js";

function buildApp(onUnknown?: (error: unknown) => void) {
  const app = Fastify();
  registerErrorHandler(app, onUnknown);
  app.get("/zod", async () => z.object({ a: z.string() }).parse({}));
  app.get("/app", async () => {
    throw new AppError("credit.insufficient", 402, "no balance", { need: 5 });
  });
  app.post("/json", async () => ({ ok: true }));
  app.get("/boom", async () => {
    throw new Error("kaboom internal detail");
  });
  return app;
}

describe("registerErrorHandler", () => {
  it("maps ZodError -> 400 request.invalid with issues", async () => {
    const res = await buildApp().inject({ method: "GET", url: "/zod" });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe("request.invalid");
    expect(body.error.details.issues).toBeDefined();
  });

  it("maps AppError -> its httpStatus, code and details", async () => {
    const res = await buildApp().inject({ method: "GET", url: "/app" });
    expect(res.statusCode).toBe(402);
    const body = res.json();
    expect(body.error.code).toBe("credit.insufficient");
    expect(body.error.message).toBe("no balance");
    expect(body.error.details).toEqual({ need: 5 });
  });

  it("maps Fastify client errors to request.invalid without leaking framework codes", async () => {
    const res = await buildApp().inject({
      method: "POST",
      url: "/json",
      headers: { "content-type": "application/json" },
      payload: "{not-json",
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe("request.invalid");
    expect(JSON.stringify(body)).not.toContain("FST_ERR");
  });

  it("maps unknown error -> 500 internal.error without leaking the message", async () => {
    const res = await buildApp().inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.error.code).toBe("internal.error");
    expect(JSON.stringify(body)).not.toContain("kaboom");
  });

  it("forwards the original request id from x-kokoro-request-id", async () => {
    const res = await buildApp().inject({
      method: "GET",
      url: "/app",
      headers: { "x-kokoro-request-id": "req-123" },
    });
    expect(res.json().requestId).toBe("req-123");
  });

  it("invokes onUnknown only for unexpected errors", async () => {
    let captured: unknown = null;
    const app = buildApp((e) => {
      captured = e;
    });
    await app.inject({ method: "GET", url: "/app" });
    expect(captured).toBeNull();
    await app.inject({ method: "GET", url: "/boom" });
    expect((captured as Error).message).toBe("kaboom internal detail");
  });
});
