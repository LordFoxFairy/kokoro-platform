import { describe, expect, it } from "vitest";
import { createPrismaClient } from "../../src/infrastructure/prisma/prisma-client.js";
import { createPaymentServer } from "../../src/interfaces/http/server.js";

// WHY: /docs/json 不触发任何查询，dummy URL 的 client 不会真实连接。
const prisma = createPrismaClient("postgresql://user:pass@localhost:5432/payment");

describe("payment OpenAPI", () => {
  it("serves /docs/json with collected route paths", async () => {
    const app = createPaymentServer({ prisma });
    try {
      const response = await app.inject({ method: "GET", url: "/docs/json" });
      expect(response.statusCode).toBe(200);
      const body = response.json<{ openapi?: string; paths: Record<string, unknown> }>();
      expect(body.openapi).toBeTruthy();
      expect(Object.keys(body.paths).length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });
});
