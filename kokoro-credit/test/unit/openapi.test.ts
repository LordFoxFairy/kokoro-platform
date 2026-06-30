import { describe, expect, it } from "vitest";
import { PrismaClient } from "../../generated/prisma/index.js";
import { createCreditServer } from "../../src/interfaces/http/server.js";

// WHY: /docs/json 不触达 prisma，构造一个不连接的 client 即可（query 才会连库）。
function createNoopPrisma(): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: "postgresql://noop" } } });
}

describe("credit OpenAPI", () => {
  it("exposes /docs/json with collected routes", async () => {
    const prisma = createNoopPrisma();
    const app = createCreditServer({ prisma });
    try {
      const response = await app.inject({ method: "GET", url: "/docs/json" });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.openapi).toBeDefined();
      expect(Object.keys(body.paths).length).toBeGreaterThan(0);
    } finally {
      await app.close();
      await prisma.$disconnect();
    }
  });
});
