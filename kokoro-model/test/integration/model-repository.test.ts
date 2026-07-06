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

  it("resolves only healthy providers ordered by priority, excluding down providers", async () => {
    const healthy = await service.ensureProviderAccount({
      provider: "openai",
      key: "healthy",
      label: "OpenAI Healthy",
      secretRef: "secret://openai/healthy",
      transportKind: "litellm",
    });
    const down = await service.ensureProviderAccount({
      provider: "anthropic",
      key: "down",
      label: "Anthropic Down",
      secretRef: "secret://anthropic/down",
      transportKind: "litellm",
    });
    await prisma.providerAccount.update({
      where: { id: down.id },
      data: { healthStatus: "down" },
    });

    await service.ensureModelBinding({
      providerAccountId: healthy.id,
      modelName: "gpt-4o-mini",
      displayName: "GPT-4o mini",
      featureKey: "chat",
      labelKeys: ["chat.default"],
      inputModalities: ["text"],
      outputModalities: ["text"],
      priority: 30,
      transportKind: "litellm",
    });
    await service.ensureModelBinding({
      providerAccountId: healthy.id,
      modelName: "gpt-4o",
      displayName: "GPT-4o",
      featureKey: "chat",
      labelKeys: ["chat.default", "chat.premium"],
      inputModalities: ["text"],
      outputModalities: ["text"],
      priority: 10,
      transportKind: "direct",
    });
    await service.ensureModelBinding({
      providerAccountId: down.id,
      modelName: "claude-3",
      displayName: "Claude 3",
      featureKey: "chat",
      labelKeys: ["chat.default"],
      inputModalities: ["text"],
      outputModalities: ["text"],
      priority: 1,
      transportKind: "litellm",
    });

    const resolved = await service.resolveModelBindings({ featureKey: "chat" });
    expect(resolved.map((binding) => binding.modelName)).toEqual(["gpt-4o", "gpt-4o-mini"]);

    const byLabel = await service.resolveModelBindings({ featureKey: "chat", labelKey: "chat.premium" });
    expect(byLabel.map((binding) => binding.modelName)).toEqual(["gpt-4o"]);

    const byTransport = await service.resolveModelBindings({ featureKey: "chat", transportKind: "litellm" });
    expect(byTransport.map((binding) => binding.modelName)).toEqual(["gpt-4o-mini"]);

    const none = await service.resolveModelBindings({ featureKey: "image" });
    expect(none).toEqual([]);
  });

  it("deletes and restores provider accounts without hard deleting their bindings", async () => {
    const account = await service.ensureProviderAccount({
      provider: "openai",
      key: "lifecycle",
      label: "OpenAI Lifecycle",
      secretRef: "secret://openai/lifecycle",
      transportKind: "litellm",
    });
    const binding = await service.ensureModelBinding({
      providerAccountId: account.id,
      modelName: "gpt-4o",
      displayName: "GPT-4o",
      featureKey: "chat",
      labelKeys: ["chat.default"],
      inputModalities: ["text"],
      outputModalities: ["text"],
      transportKind: "litellm",
      gatewayModelName: "openai/gpt-4o",
    });

    const deleted = await repository.deleteProviderAccount({
      id: account.id,
      deletedBy: "operator-1",
      reason: "secret rotated",
    });

    expect(deleted.deletedAt).toBeInstanceOf(Date);
    expect(deleted.deletedBy).toBe("operator-1");
    expect(deleted.deleteReason).toBe("secret rotated");
    await expect(
      service.ensureProviderAccount({
        provider: "openai",
        key: "lifecycle",
        label: "OpenAI Lifecycle Updated",
        secretRef: "secret://openai/lifecycle-v2",
        transportKind: "litellm",
      }),
    ).rejects.toMatchObject({ code: "model.provider_account.deleted" });
    expect(await repository.listProviderAccounts()).toEqual([]);
    expect((await repository.listProviderAccounts({ includeDeleted: true })).map((row) => row.id)).toEqual([
      account.id,
    ]);
    expect(await service.resolveModelBindings({ featureKey: "chat" })).toEqual([]);
    expect(await prisma.modelBinding.findUnique({ where: { id: binding.id } })).not.toBeNull();

    const restored = await repository.restoreProviderAccount({ id: account.id });
    expect(restored.deletedAt).toBeNull();
    expect(restored.deletedBy).toBeNull();
    expect(restored.deleteReason).toBeNull();
    expect((await service.resolveModelBindings({ featureKey: "chat" })).map((row) => row.modelName)).toEqual([
      "gpt-4o",
    ]);
  });

  it("deletes and restores model bindings without affecting sibling bindings", async () => {
    const account = await service.ensureProviderAccount({
      provider: "openai",
      key: "binding_lifecycle",
      label: "OpenAI Binding Lifecycle",
      secretRef: "secret://openai/binding-lifecycle",
      transportKind: "litellm",
    });
    const primary = await service.ensureModelBinding({
      providerAccountId: account.id,
      modelName: "gpt-4o",
      displayName: "GPT-4o",
      featureKey: "chat",
      labelKeys: ["chat.default"],
      inputModalities: ["text"],
      outputModalities: ["text"],
      transportKind: "litellm",
      gatewayModelName: "openai/gpt-4o",
      priority: 10,
    });
    await service.ensureModelBinding({
      providerAccountId: account.id,
      modelName: "gpt-4o-mini",
      displayName: "GPT-4o mini",
      featureKey: "chat",
      labelKeys: ["chat.default"],
      inputModalities: ["text"],
      outputModalities: ["text"],
      transportKind: "litellm",
      gatewayModelName: "openai/gpt-4o-mini",
      priority: 20,
    });

    const deleted = await repository.deleteModelBinding({
      id: primary.id,
      deletedBy: "operator-1",
      reason: "retired",
    });

    expect(deleted.deletedAt).toBeInstanceOf(Date);
    expect(deleted.deletedBy).toBe("operator-1");
    expect(deleted.deleteReason).toBe("retired");
    await expect(
      service.ensureModelBinding({
        providerAccountId: account.id,
        modelName: "gpt-4o",
        displayName: "GPT-4o Updated",
        featureKey: "chat",
        labelKeys: ["chat.default"],
        inputModalities: ["text"],
        outputModalities: ["text"],
        transportKind: "litellm",
        gatewayModelName: "openai/gpt-4o",
      }),
    ).rejects.toMatchObject({ code: "model.binding.deleted" });
    expect((await repository.listAllModelBindings()).map((row) => row.modelName)).toEqual([
      "gpt-4o-mini",
    ]);
    expect((await repository.listAllModelBindings({ includeDeleted: true })).map((row) => row.modelName).sort()).toEqual([
      "gpt-4o",
      "gpt-4o-mini",
    ]);
    expect((await service.listModelBindings({ featureKey: "chat" })).map((row) => row.modelName)).toEqual([
      "gpt-4o-mini",
    ]);
    expect((await service.resolveModelBindings({ featureKey: "chat" })).map((row) => row.modelName)).toEqual([
      "gpt-4o-mini",
    ]);

    const restored = await repository.restoreModelBinding({ id: primary.id });
    expect(restored.deletedAt).toBeNull();
    expect(restored.deletedBy).toBeNull();
    expect(restored.deleteReason).toBeNull();
    expect((await service.resolveModelBindings({ featureKey: "chat" })).map((row) => row.modelName)).toEqual([
      "gpt-4o",
      "gpt-4o-mini",
    ]);
  });
});
