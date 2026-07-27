import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createModelServer } from "../../src/interfaces/http/server.js";
import { cleanModelDatabase, createTestPrismaClient } from "./helpers.js";

const prisma = createTestPrismaClient();
const app = createModelServer({ prisma });

async function createProviderAccount(provider = "openai", key = "main"): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/provider-accounts/ensure",
    payload: {
      provider,
      key,
      label: `${provider} ${key}`,
      secretRef: `secret://${provider}/${key}`,
      transportKind: "litellm",
    },
  });
  expect(response.statusCode).toBe(200);
  return response.json().data.id;
}

async function createBinding(providerAccountId: string, modelName: string, priority: number): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/model-bindings/ensure",
    payload: {
      providerAccountId,
      modelName,
      displayName: modelName,
      featureKey: "chat",
      labelKeys: ["chat.default"],
      inputModalities: ["text"],
      outputModalities: ["text"],
      transportKind: "litellm",
      gatewayModelName: `openai/${modelName}`,
      priority,
    },
  });
  expect(response.statusCode).toBe(200);
  return response.json().data.id;
}

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
      url: "/model-bindings/resolve?siteId=site-a&featureKey=music&labelKey=music.default",
    });

    expect(resolveResponse.statusCode).toBe(200);
    expect(resolveResponse.json().data.map((binding: { modelName: string }) => binding.modelName)).toEqual([
      "tad-music-v1",
    ]);
  });

  it("deletes and restores provider accounts through HTTP lifecycle routes", async () => {
    const accountId = await createProviderAccount("openai", "delete_provider");
    await createBinding(accountId, "gpt-4o", 10);

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/provider-accounts/${accountId}`,
      payload: { deletedBy: "operator-1", reason: "secret rotated" },
    });
    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json().data.deletedBy).toBe("operator-1");
    expect(deleteResponse.json().data.deletedAt).toBeTypeOf("string");

    const ensureResponse = await app.inject({
      method: "POST",
      url: "/provider-accounts/ensure",
      payload: {
        provider: "openai",
        key: "delete_provider",
        label: "OpenAI Restored?",
        secretRef: "secret://openai/delete-provider-2",
        transportKind: "litellm",
      },
    });
    expect(ensureResponse.statusCode).toBe(409);
    expect(ensureResponse.json().error.code).toBe("model.provider_account.deleted");

    const afterDelete = await app.inject({
      method: "GET",
      url: "/model-bindings/resolve?siteId=site-a&featureKey=chat",
    });
    expect(afterDelete.json().data).toEqual([]);

    const restoreResponse = await app.inject({
      method: "POST",
      url: `/provider-accounts/${accountId}/restore`,
    });
    expect(restoreResponse.statusCode).toBe(200);
    expect(restoreResponse.json().data.deletedAt).toBeNull();

    const afterRestore = await app.inject({
      method: "GET",
      url: "/model-bindings/resolve?siteId=site-a&featureKey=chat",
    });
    expect(afterRestore.json().data.map((row: { modelName: string }) => row.modelName)).toEqual([
      "gpt-4o",
    ]);
  });

  it("deletes and restores model bindings through HTTP lifecycle routes", async () => {
    const accountId = await createProviderAccount("openai", "delete_binding");
    const primaryId = await createBinding(accountId, "gpt-4o", 10);
    await createBinding(accountId, "gpt-4o-mini", 20);

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/model-bindings/${primaryId}`,
      payload: { deletedBy: "operator-1", reason: "retired" },
    });
    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json().data.deletedBy).toBe("operator-1");

    const listAfterDelete = await app.inject({ method: "GET", url: "/model-bindings?featureKey=chat" });
    expect(listAfterDelete.json().data.map((row: { modelName: string }) => row.modelName)).toEqual([
      "gpt-4o-mini",
    ]);

    const ensureResponse = await app.inject({
      method: "POST",
      url: "/model-bindings/ensure",
      payload: {
        providerAccountId: accountId,
        modelName: "gpt-4o",
        displayName: "GPT-4o Updated",
        featureKey: "chat",
        labelKeys: ["chat.default"],
        inputModalities: ["text"],
        outputModalities: ["text"],
        transportKind: "litellm",
        gatewayModelName: "openai/gpt-4o",
      },
    });
    expect(ensureResponse.statusCode).toBe(409);
    expect(ensureResponse.json().error.code).toBe("model.binding.deleted");

    const restoreResponse = await app.inject({
      method: "POST",
      url: `/model-bindings/${primaryId}/restore`,
    });
    expect(restoreResponse.statusCode).toBe(200);
    expect(restoreResponse.json().data.deletedAt).toBeNull();

    const resolveAfterRestore = await app.inject({
      method: "GET",
      url: "/model-bindings/resolve?siteId=site-a&featureKey=chat",
    });
    expect(resolveAfterRestore.json().data.map((row: { modelName: string }) => row.modelName)).toEqual([
      "gpt-4o",
      "gpt-4o-mini",
    ]);
  });
});
