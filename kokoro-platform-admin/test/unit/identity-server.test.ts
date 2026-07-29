import { describe, expect, it } from "vitest";
import { createAdminIdentityServer } from "../../src/identity-server.js";

describe("Admin identity-only production server", () => {
  it("does not register legacy MySQL authority or module proxy routes", async () => {
    const app = createAdminIdentityServer({
      store: {} as never,
      workload: {} as never,
      telemetry: {} as never,
    });
    try {
      for (const route of ["/api/action", "/api/approvals", "/api/operators", "/api/roles",
        "/api/resource", "/api/manifests"]) {
        const response = await app.inject({ method: route === "/api/action" ? "POST" : "GET", url: route });
        expect(response.statusCode, route).toBe(404);
      }
      expect(app.printRoutes()).toContain("kokoro.platform.admin.v1.AdminAuthService");
    } finally {
      await app.close();
    }
  });
});
