import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../../generated/prisma/index.js";
import { createModelServer } from "../../src/interfaces/http/server.js";

// WHY: /docs/json 不触发任何 DB 查询，故传未连接的 PrismaClient 即可（构造不连接）。
const prisma = new PrismaClient({ datasources: { db: { url: "file:./openapi-test.db" } } });
const app = createModelServer({ prisma });

describe("model OpenAPI docs", () => {
  afterAll(async () => {
    await app.close();
  });

  it("exposes /docs/json with collected route paths", async () => {
    await app.ready();
    const response = await app.inject({ method: "GET", url: "/docs/json" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.openapi).toBeDefined();
    expect(Object.keys(body.paths).length).toBeGreaterThan(0);
  });
});
