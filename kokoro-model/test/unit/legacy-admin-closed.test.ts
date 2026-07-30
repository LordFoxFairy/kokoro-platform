import { describe, expect, it } from "vitest";
import type { PrismaClient } from "../../generated/prisma/index.js";
import { createModelServer } from "../../src/interfaces/http/server.js";
import { modelPlatformModule } from "../../src/module.js";

describe("retired kokoro-model administration surface", () => {
  it("does not register any legacy or product mutation HTTP route", async () => {
    const app = createModelServer({
      prisma: {} as PrismaClient,
    });
    try {
      for (const [method, url] of [
        ["GET", "/admin/models/provider-accounts"],
        ["POST", "/provider-accounts/ensure"],
        ["DELETE", "/provider-accounts/provider-one"],
        ["POST", "/provider-accounts/provider-one/restore"],
        ["POST", "/model-bindings/ensure"],
        ["DELETE", "/model-bindings/binding-one"],
        ["POST", "/model-bindings/binding-one/restore"],
        ["POST", "/model-labels/ensure"],
      ] as const) {
        expect((await app.inject({ method, url, payload: {} })).statusCode, `${method} ${url}`).toBe(404);
      }
    } finally {
      await app.close();
    }
  });

  it("publishes only GET runtime model operations in OpenAPI", async () => {
    const app = createModelServer({ prisma: {} as PrismaClient });
    try {
      const response = await app.inject({ method: "GET", url: "/docs/json" });
      expect(response.statusCode).toBe(200);
      const paths = response.json().paths as Record<string, Record<string, unknown>>;
      for (const [path, operations] of Object.entries(paths)) {
        if (path.startsWith("/model-") || path.startsWith("/provider-")) {
          expect(Object.keys(operations), path).toEqual(["get"]);
        }
      }
      expect(paths).not.toHaveProperty("/provider-accounts/ensure");
      expect(paths).not.toHaveProperty("/model-bindings/ensure");
      expect(paths).not.toHaveProperty("/model-labels/ensure");
    } finally {
      await app.close();
    }
  });

  it("advertises only product HTTP and internal API surfaces", () => {
    expect(modelPlatformModule).not.toHaveProperty("admin");
    expect(modelPlatformModule.runtime.surfaces).toEqual(["http", "internal-api"]);
    expect(modelPlatformModule.runtime.routes.every((route) => route.startsWith("GET "))).toBe(true);
  });
});
