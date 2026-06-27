import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { z, ZodError } from "zod";
import { registerHealthRoute, sendData, sendError, sendZodError } from "../src/http/responses.js";

describe("HTTP helpers", () => {
  it("registers consistent health output", async () => {
    const app = Fastify({ logger: false });
    registerHealthRoute(app, "model");

    const response = await app.inject({
      method: "GET",
      url: "/healthz",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        module: "model",
        status: "ok",
      },
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
    expect((await app.inject("/error")).json().error.code).toBe("payment.idempotency_conflict");
    expect((await app.inject("/zod")).statusCode).toBe(400);
  });
});
