import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ModelService } from "../../src/application/model-service.js";
import { PrismaModelRepository } from "../../src/infrastructure/prisma/prisma-model-repository.js";
import { cleanModelDatabase, createTestPrismaClient } from "./helpers.js";

const prisma = createTestPrismaClient();
const repository = new PrismaModelRepository(prisma);
const service = new ModelService(repository);

describe("PrismaModelRepository", () => {
  beforeEach(async () => {
    await cleanModelDatabase(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("ensures a provider account and model binding idempotently", async () => {
    const account = await service.ensureProviderAccount({
      provider: "suno",
      key: "main",
      label: "Suno Main",
      secretRef: "secret://suno/main",
      priority: 10,
      transportKind: "direct",
    });

    const first = await service.ensureModelBinding({
      providerAccountId: account.id,
      modelName: "chirp-v4",
      displayName: "Chirp v4",
      featureKey: "music",
      labelKeys: ["music.default", "music.fast"],
      inputModalities: ["text"],
      outputModalities: ["audio"],
      priority: 20,
      transportKind: "direct",
    });

    const second = await service.ensureModelBinding({
      providerAccountId: account.id,
      modelName: "chirp-v4",
      displayName: "Chirp v4 Updated",
      featureKey: "music",
      labelKeys: ["music.default"],
      inputModalities: ["text"],
      outputModalities: ["audio"],
      priority: 5,
      transportKind: "direct",
    });

    expect(second.id).toBe(first.id);
    expect(second.displayName).toBe("Chirp v4 Updated");
    expect(second.priority).toBe(5);
  });

  it("lists active model bindings by feature and label", async () => {
    const account = await service.ensureProviderAccount({
      provider: "replicate",
      key: "fallback",
      label: "Replicate Fallback",
      secretRef: "secret://replicate/fallback",
      priority: 50,
      transportKind: "direct",
    });

    await service.ensureModelBinding({
      providerAccountId: account.id,
      modelName: "musicgen",
      displayName: "MusicGen",
      featureKey: "music",
      labelKeys: ["music.default"],
      inputModalities: ["text"],
      outputModalities: ["audio"],
      priority: 10,
      transportKind: "direct",
    });

    await service.ensureModelBinding({
      providerAccountId: account.id,
      modelName: "video-gen",
      displayName: "Video Gen",
      featureKey: "video",
      labelKeys: ["video.default"],
      inputModalities: ["text"],
      outputModalities: ["video"],
      priority: 20,
      transportKind: "direct",
    });

    const bindings = await service.listModelBindings({
      featureKey: "music",
      labelKey: "music.default",
    });

    expect(bindings.map((binding) => binding.modelName)).toEqual(["musicgen"]);
  });
});
