import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createModelServer } from "../../src/interfaces/http/server.js";
import { cleanModelDatabase, createTestPrismaClient } from "./helpers.js";

const prisma = createTestPrismaClient();
const app = createModelServer({ prisma });

describe("model admin API", () => {
  beforeEach(async () => {
    await cleanModelDatabase(prisma);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it("exposes the admin manifest", async () => {
    const response = await app.inject({ method: "GET", url: "/admin/models/manifest" });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.id).toBe("kokoro-model");
  });

  it("returns empty arrays for each list endpoint", async () => {
    for (const url of [
      "/admin/models/provider-accounts",
      "/admin/models/bindings",
      "/admin/models/labels",
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);
      expect(Array.isArray(response.json().data)).toBe(true);
      expect(response.json().data).toHaveLength(0);
    }
  });

  it("surfaces seeded rows across the list endpoints", async () => {
    const account = await prisma.providerAccount.create({
      data: {
        provider: "tad",
        key: "main",
        label: "Tad Main",
        secretRef: "secret://tad/main",
        transportKind: "direct",
        status: "active",
      },
    });

    await prisma.modelBinding.create({
      data: {
        providerAccountId: account.id,
        provider: "tad",
        modelName: "tad-music-v1",
        displayName: "Tad Music v1",
        featureKey: "music",
        labelKeys: ["music.default"],
        inputModalities: ["text"],
        outputModalities: ["audio"],
        transportKind: "direct",
        status: "active",
      },
    });

    await prisma.modelLabel.create({
      data: {
        key: "music.default",
        displayName: "Default Music",
        featureKey: "music",
        status: "active",
      },
    });

    const accounts = await app.inject({ method: "GET", url: "/admin/models/provider-accounts" });
    expect(accounts.json().data.map((row: { provider: string }) => row.provider)).toEqual(["tad"]);

    const bindings = await app.inject({ method: "GET", url: "/admin/models/bindings" });
    expect(bindings.json().data.map((row: { modelName: string }) => row.modelName)).toEqual([
      "tad-music-v1",
    ]);

    const labels = await app.inject({ method: "GET", url: "/admin/models/labels" });
    expect(labels.json().data.map((row: { key: string }) => row.key)).toEqual(["music.default"]);
  });
});
