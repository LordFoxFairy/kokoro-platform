import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerOpenApi } from "../src/http/openapi.js";

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function createDocumentedApp() {
  const app = Fastify({ logger: false });
  apps.push(app);
  registerOpenApi(app, { title: "Contract Test API", version: "1.0.0" });
  void app.register(async (instance) => {
    instance.get(
      "/example",
      { schema: { response: { 200: { type: "object" } } } },
      async () => ({}),
    );
  });
  return app;
}

describe("OpenAPI contract endpoint", () => {
  it("serves the collected OpenAPI document at /docs/json", async () => {
    const app = createDocumentedApp();

    const response = await app.inject({ method: "GET", url: "/docs/json" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      openapi: expect.any(String),
      info: { title: "Contract Test API", version: "1.0.0" },
      paths: { "/example": expect.any(Object) },
    });
  });

  it.each([
    "/docs",
    "/docs/",
    "/docs/yaml",
    "/docs/static/index.html",
    "/docs/static/swagger-initializer.js",
  ])("does not expose the non-contract documentation surface %s", async (url) => {
    const app = createDocumentedApp();

    const response = await app.inject({ method: "GET", url });

    expect(response.statusCode).toBe(404);
  });
});
