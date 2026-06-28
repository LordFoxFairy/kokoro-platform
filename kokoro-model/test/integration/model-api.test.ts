import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createModelServer } from "../../src/interfaces/http/server.js";
import { cleanModelDatabase, createTestPrismaClient } from "./helpers.js";

const prisma = createTestPrismaClient();
const app = createModelServer({ prisma });

describe("model HTTP API", () => {
  beforeEach(async () => {
    await cleanModelDatabase(prisma);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it("ensures model config and returns bindings by feature", async () => {
    const accountResponse = await app.inject({
      method: "POST",
      url: "/provider-accounts/ensure",
      payload: {
        provider: "tad",
        key: "main",
        label: "Tad Main",
        secretRef: "secret://tad/main",
        transportKind: "direct",
      },
    });

    expect(accountResponse.statusCode).toBe(200);
    const accountId = accountResponse.json().data.id;

    const bindingResponse = await app.inject({
      method: "POST",
      url: "/model-bindings/ensure",
      payload: {
        providerAccountId: accountId,
        modelName: "tad-music-v1",
        displayName: "Tad Music v1",
        featureKey: "music",
        labelKeys: ["music.default"],
        inputModalities: ["text"],
        outputModalities: ["audio"],
        transportKind: "direct",
      },
    });

    expect(bindingResponse.statusCode).toBe(200);

    const listResponse = await app.inject({
      method: "GET",
      url: "/model-bindings?featureKey=music&labelKey=music.default",
    });

    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json().data.map((binding: { modelName: string }) => binding.modelName)).toEqual([
      "tad-music-v1",
    ]);

    const resolveResponse = await app.inject({
      method: "GET",
      url: "/model-bindings/resolve?featureKey=music&labelKey=music.default",
    });

    expect(resolveResponse.statusCode).toBe(200);
    expect(resolveResponse.json().data.map((binding: { modelName: string }) => binding.modelName)).toEqual([
      "tad-music-v1",
    ]);
  });
});
