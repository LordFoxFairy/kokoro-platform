import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ModelService } from "../../src/application/model-service.js";
import { createModelServer } from "../../src/interfaces/http/server.js";
import { PrismaModelRepository } from "../../src/infrastructure/prisma/prisma-model-repository.js";
import { cleanModelDatabase, createTestPrismaClient } from "./helpers.js";

const prisma = createTestPrismaClient();
const app = createModelServer({ prisma });
const bootstrap = new ModelService(new PrismaModelRepository(prisma));

describe("read-only model runtime HTTP API", () => {
  beforeEach(async () => {
    await cleanModelDatabase(prisma);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it("lists and resolves a catalog provisioned through the explicit offline bootstrap authority", async () => {
    const account = await bootstrap.ensureProviderAccount({
      provider: "tad", key: "main", label: "Tad Main", secretRef: "secret://tad/main",
      transportKind: "direct",
    });
    await bootstrap.ensureModelBinding({
      providerAccountId: account.id, modelName: "tad-music-v1", displayName: "Tad Music v1",
      featureKey: "music", labelKeys: ["music.default"], inputModalities: ["text"],
      outputModalities: ["audio"], transportKind: "direct",
    });

    const listResponse = await app.inject({
      method: "GET", url: "/model-bindings?featureKey=music&labelKey=music.default",
    });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json().data.map((binding: { modelName: string }) => binding.modelName))
      .toEqual(["tad-music-v1"]);

    const resolveResponse = await app.inject({
      method: "GET", url: "/model-bindings/resolve?siteId=site-a&featureKey=music&labelKey=music.default",
    });
    expect(resolveResponse.statusCode).toBe(200);
    expect(resolveResponse.json().data.map((binding: { modelName: string }) => binding.modelName))
      .toEqual(["tad-music-v1"]);
  });
});
