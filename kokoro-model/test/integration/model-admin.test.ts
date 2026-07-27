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

  it("disables a provider account so resolve skips its bindings, then re-enables", async () => {
    const account = await prisma.providerAccount.create({
      data: {
        provider: "openai",
        key: "main",
        label: "OpenAI Main",
        secretRef: "secret://openai/main",
        transportKind: "litellm",
        status: "active",
      },
    });

    await prisma.modelBinding.create({
      data: {
        providerAccountId: account.id,
        provider: "openai",
        modelName: "gpt-4o",
        displayName: "GPT-4o",
        featureKey: "chat",
        labelKeys: [],
        inputModalities: ["text"],
        outputModalities: ["text"],
        transportKind: "litellm",
        status: "active",
      },
    });

    const before = await app.inject({
      method: "GET",
      url: "/model-bindings/resolve?siteId=site-a&featureKey=chat",
    });
    expect(before.json().data.map((row: { modelName: string }) => row.modelName)).toEqual([
      "gpt-4o",
    ]);

    const disabled = await app.inject({
      method: "POST",
      url: `/admin/models/provider-accounts/${account.id}/disable`,
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().data.status).toBe("disabled");

    const afterDisable = await app.inject({
      method: "GET",
      url: "/model-bindings/resolve?siteId=site-a&featureKey=chat",
    });
    expect(afterDisable.json().data).toHaveLength(0);

    const enabled = await app.inject({
      method: "POST",
      url: `/admin/models/provider-accounts/${account.id}/enable`,
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().data.status).toBe("active");

    const afterEnable = await app.inject({
      method: "GET",
      url: "/model-bindings/resolve?siteId=site-a&featureKey=chat",
    });
    expect(afterEnable.json().data.map((row: { modelName: string }) => row.modelName)).toEqual([
      "gpt-4o",
    ]);
  });

  it("disabling a binding removes it from resolve and is idempotent", async () => {
    const account = await prisma.providerAccount.create({
      data: {
        provider: "openai",
        key: "main",
        label: "OpenAI Main",
        secretRef: "secret://openai/main",
        transportKind: "litellm",
        status: "active",
      },
    });

    const binding = await prisma.modelBinding.create({
      data: {
        providerAccountId: account.id,
        provider: "openai",
        modelName: "gpt-4o",
        displayName: "GPT-4o",
        featureKey: "chat",
        labelKeys: [],
        inputModalities: ["text"],
        outputModalities: ["text"],
        transportKind: "litellm",
        status: "active",
      },
    });

    const first = await app.inject({
      method: "POST",
      url: `/admin/models/bindings/${binding.id}/disable`,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().data.status).toBe("disabled");

    const second = await app.inject({
      method: "POST",
      url: `/admin/models/bindings/${binding.id}/disable`,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().data.status).toBe("disabled");

    const afterDisable = await app.inject({
      method: "GET",
      url: "/model-bindings/resolve?siteId=site-a&featureKey=chat",
    });
    expect(afterDisable.json().data).toHaveLength(0);

    const enabled = await app.inject({
      method: "POST",
      url: `/admin/models/bindings/${binding.id}/enable`,
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().data.status).toBe("active");
  });

  it("returns 404 for unknown provider account and binding ids", async () => {
    const account = await app.inject({
      method: "POST",
      url: "/admin/models/provider-accounts/00000000-0000-0000-0000-000000000000/disable",
    });
    expect(account.statusCode).toBe(404);
    expect(account.json().error.code).toBe("model.provider_account_not_found");

    const binding = await app.inject({
      method: "POST",
      url: "/admin/models/bindings/00000000-0000-0000-0000-000000000000/enable",
    });
    expect(binding.statusCode).toBe(404);
    expect(binding.json().error.code).toBe("model.binding_not_found");
  });

  it("includes deleted provider accounts and bindings for restore workflows", async () => {
    const account = await prisma.providerAccount.create({
      data: {
        provider: "openai",
        key: "admin_deleted",
        label: "OpenAI Deleted",
        secretRef: "secret://openai/admin-deleted",
        transportKind: "litellm",
        status: "active",
        deletedAt: new Date(),
        deletedBy: "operator-1",
        deleteReason: "retired",
      },
    });
    await prisma.modelBinding.create({
      data: {
        providerAccountId: account.id,
        provider: "openai",
        modelName: "gpt-4o",
        displayName: "GPT-4o",
        featureKey: "chat",
        labelKeys: ["chat.default"],
        inputModalities: ["text"],
        outputModalities: ["text"],
        transportKind: "litellm",
        gatewayModelName: "openai/gpt-4o",
        status: "active",
        deletedAt: new Date(),
        deletedBy: "operator-1",
        deleteReason: "retired",
      },
    });

    const accounts = await app.inject({ method: "GET", url: "/admin/models/provider-accounts" });
    expect(accounts.statusCode).toBe(200);
    expect(accounts.json().data.map((row: { id: string }) => row.id)).toEqual([account.id]);
    expect(accounts.json().data[0].deletedBy).toBe("operator-1");

    const bindings = await app.inject({ method: "GET", url: "/admin/models/bindings" });
    expect(bindings.statusCode).toBe(200);
    expect(bindings.json().data.map((row: { modelName: string }) => row.modelName)).toEqual(["gpt-4o"]);
    expect(bindings.json().data[0].deletedBy).toBe("operator-1");
  });

  it("deletes and restores provider accounts and bindings through admin routes", async () => {
    const account = await prisma.providerAccount.create({
      data: {
        provider: "openai",
        key: "admin_lifecycle",
        label: "OpenAI Admin Lifecycle",
        secretRef: "secret://openai/admin-lifecycle",
        transportKind: "litellm",
        status: "active",
      },
    });
    const binding = await prisma.modelBinding.create({
      data: {
        providerAccountId: account.id,
        provider: "openai",
        modelName: "gpt-4o",
        displayName: "GPT-4o",
        featureKey: "chat",
        labelKeys: ["chat.default"],
        inputModalities: ["text"],
        outputModalities: ["text"],
        transportKind: "litellm",
        gatewayModelName: "openai/gpt-4o",
        status: "active",
      },
    });

    const deleteBinding = await app.inject({
      method: "DELETE",
      url: `/admin/models/bindings/${binding.id}`,
      payload: { deletedBy: "operator-1", reason: "retired" },
    });
    expect(deleteBinding.statusCode).toBe(200);
    expect(deleteBinding.json().data.deletedBy).toBe("operator-1");

    const restoreBinding = await app.inject({
      method: "POST",
      url: `/admin/models/bindings/${binding.id}/restore`,
    });
    expect(restoreBinding.statusCode).toBe(200);
    expect(restoreBinding.json().data.deletedAt).toBeNull();

    const deleteProvider = await app.inject({
      method: "DELETE",
      url: `/admin/models/provider-accounts/${account.id}`,
      payload: { deletedBy: "operator-1", reason: "secret rotated" },
    });
    expect(deleteProvider.statusCode).toBe(200);
    expect(deleteProvider.json().data.deletedBy).toBe("operator-1");

    const restoreProvider = await app.inject({
      method: "POST",
      url: `/admin/models/provider-accounts/${account.id}/restore`,
    });
    expect(restoreProvider.statusCode).toBe(200);
    expect(restoreProvider.json().data.deletedAt).toBeNull();
  });
});
