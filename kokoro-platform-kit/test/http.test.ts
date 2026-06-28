import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { z, ZodError } from "zod";
import {
  isZodError,
  registerHealthRoute,
  sendData,
  sendError,
  sendUnknownError,
  sendZodError,
} from "../src/http/responses.js";

describe("HTTP helpers", () => {
  it("registers consistent health output", async () => {
    const app = Fastify({ logger: false });
    registerHealthRoute(app, "model");

    const response = await app.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: { module: "model", status: "ok" },
    });
  });

  it("sends consistent data and error envelopes", async () => {
    const app = Fastify({ logger: false });

    app.get("/data", async (_request, reply) => sendData(reply, { id: "ok" }));
    app.get("/error", async (_request, reply) =>
      sendError(reply, 409, "payment.idempotency_conflict", "幂等键请求参数不一致"),
    );
    app.get("/zod", async (_request, reply) => {
      try {
        z.object({ id: z.string() }).parse({});
      } catch (error) {
        return sendZodError(reply, error as ZodError);
      }
    });

    expect((await app.inject("/data")).json()).toEqual({ data: { id: "ok" } });
    expect((await app.inject("/error")).json().error.code).toBe(
      "payment.idempotency_conflict",
    );
    const zod = await app.inject("/zod");
    expect(zod.statusCode).toBe(400);
    expect(zod.json().error.code).toBe("request.invalid");
  });

  it("threads requestId and details through the envelopes", async () => {
    const app = Fastify({ logger: false });

    app.get("/data", async (_request, reply) =>
      sendData(reply, { id: "ok" }, 201, "req-1"),
    );
    app.get("/error", async (_request, reply) =>
      sendError(reply, 422, "x.bad", "bad", { hint: "fix" }, "req-2"),
    );

    const data = await app.inject("/data");
    expect(data.statusCode).toBe(201);
    expect(data.json()).toEqual({ data: { id: "ok" }, requestId: "req-1" });

    const error = await app.inject("/error");
    expect(error.statusCode).toBe(422);
    expect(error.json()).toEqual({
      error: { code: "x.bad", message: "bad", details: { hint: "fix" } },
      requestId: "req-2",
    });
  });

  it("omits requestId and details when not provided", async () => {
    const app = Fastify({ logger: false });
    app.get("/error", async (_request, reply) =>
      sendError(reply, 400, "x.bad", "bad"),
    );

    const body = (await app.inject("/error")).json();
    expect(body).not.toHaveProperty("requestId");
    expect(body.error).not.toHaveProperty("details");
  });

  it("sends a 500 unknown error envelope", async () => {
    const app = Fastify({ logger: false });
    app.get("/boom", async (_request, reply) =>
      sendUnknownError(reply, "x.unknown", "boom"),
    );

    const response = await app.inject("/boom");
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: "x.unknown", message: "boom" },
    });
  });
});

describe("isZodError", () => {
  it("returns true for a ZodError", () => {
    const error = z.object({ id: z.string() }).safeParse({});
    expect(error.success).toBe(false);
    if (!error.success) {
      expect(isZodError(error.error)).toBe(true);
    }
  });

  it.each([new Error("plain"), "string", null, undefined, {}])(
    "returns false for non-ZodError %s",
    (value) => {
      expect(isZodError(value)).toBe(false);
    },
  );
});
