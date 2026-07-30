import { afterAll, describe, expect, it } from "vitest";
import { createModelServer } from "../../src/interfaces/http/server.js";
import { createTestPrismaClient } from "./helpers.js";

const prisma = createTestPrismaClient();
const app = createModelServer({ prisma });

describe("model runtime HTTP strict boundary", () => {
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it("rejects unknown query params on the read-only model bindings list", async () => {
    const response = await app.inject({ method: "GET", url: "/model-bindings?featureKey=chat&junk=1" });
    expect(response.statusCode).toBe(400);
  });
});
