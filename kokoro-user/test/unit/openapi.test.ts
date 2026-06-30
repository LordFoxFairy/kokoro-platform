import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createUserServer } from "../../src/interfaces/http/server.js";

const docsJsonSchema = z.object({
  openapi: z.string().min(1),
  paths: z.record(z.unknown()),
});

describe("user OpenAPI", () => {
  it("serves /docs/json with collected route paths", async () => {
    // 注入惰性 PrismaClient：/docs/json 不触达 DB，故不会真正连接。
    const prisma = new PrismaClient({ datasources: { db: { url: "postgresql://x" } } });
    const app = createUserServer({ prisma });
    try {
      const response = await app.inject({ method: "GET", url: "/docs/json" });
      expect(response.statusCode).toBe(200);

      const body = docsJsonSchema.parse(response.json());
      expect(body.openapi).toBeTruthy();
      expect(Object.keys(body.paths).length).toBeGreaterThan(0);
    } finally {
      await app.close();
      await prisma.$disconnect();
    }
  });
});
