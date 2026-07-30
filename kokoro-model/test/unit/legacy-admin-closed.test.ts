import { describe, expect, it } from "vitest";
import type { PrismaClient } from "../../generated/prisma/index.js";
import { createModelServer } from "../../src/interfaces/http/server.js";
import { modelPlatformModule } from "../../src/module.js";

describe("retired kokoro-model administration surface", () => {
  it("does not register the legacy Admin backend even for an authenticated admin caller", async () => {
    const app = createModelServer({
      prisma: {} as PrismaClient,
      routeAccess: {
        isProduction: false,
        secrets: { admin: "admin-secret", session: "session-secret" },
      },
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/admin/models/provider-accounts",
        headers: {
          "x-kokoro-service": "admin",
          "x-kokoro-internal-secret": "admin-secret",
        },
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("advertises only product HTTP and internal API surfaces", () => {
    expect(modelPlatformModule).not.toHaveProperty("admin");
    expect(modelPlatformModule.runtime.surfaces).toEqual(["http", "internal-api"]);
  });
});
