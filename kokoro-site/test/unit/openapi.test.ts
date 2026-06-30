import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSiteServer } from "../../src/interfaces/http/server.js";

// Prisma client 仅构造不连接；/docs/json 只读已注册路由的 schema，不触发查询。
describe("openapi /docs/json", () => {
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env.DATABASE_URL_SITE;
    process.env.DATABASE_URL_SITE = "mysql://root:pw@127.0.0.1:3307/kokoro";
  });

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.DATABASE_URL_SITE;
    } else {
      process.env.DATABASE_URL_SITE = previous;
    }
  });

  it("serves an OpenAPI document with the registered routes collected", async () => {
    const app = createSiteServer();
    try {
      const response = await app.inject({ method: "GET", url: "/docs/json" });
      expect(response.statusCode).toBe(200);

      const body = response.json();
      expect(body.openapi).toBeDefined();
      expect(Object.keys(body.paths).length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });
});
