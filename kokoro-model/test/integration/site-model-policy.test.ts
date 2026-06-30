import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createModelServer } from "../../src/interfaces/http/server.js";
import { cleanModelDatabase, createTestPrismaClient } from "./helpers.js";

const prisma = createTestPrismaClient();
const app = createModelServer({ prisma });

async function seedChatBindings(): Promise<void> {
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
      labelKeys: ["chat.default", "chat.premium"],
      inputModalities: ["text"],
      outputModalities: ["text"],
      transportKind: "litellm",
      status: "active",
    },
  });

  await prisma.modelBinding.create({
    data: {
      providerAccountId: account.id,
      provider: "openai",
      modelName: "gpt-4o-mini",
      displayName: "GPT-4o mini",
      featureKey: "chat",
      labelKeys: ["chat.default"],
      inputModalities: ["text"],
      outputModalities: ["text"],
      transportKind: "litellm",
      status: "active",
    },
  });
}

describe("site model policy API", () => {
  beforeEach(async () => {
    await cleanModelDatabase(prisma);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it("upserts a policy and lists it, scoped by siteId", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/admin/models/site-policies",
      payload: { siteId: "site-a", labelKey: "chat.premium", status: "hidden" },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().data.status).toBe("hidden");

    // upsert is idempotent on (siteId, labelKey): second call flips status, no duplicate.
    const updated = await app.inject({
      method: "POST",
      url: "/admin/models/site-policies",
      payload: { siteId: "site-a", labelKey: "chat.premium", status: "visible" },
    });
    expect(updated.json().data.id).toBe(created.json().data.id);
    expect(updated.json().data.status).toBe("visible");

    const all = await app.inject({ method: "GET", url: "/admin/models/site-policies" });
    expect(all.json().data).toHaveLength(1);

    const filtered = await app.inject({
      method: "GET",
      url: "/admin/models/site-policies?siteId=site-b",
    });
    expect(filtered.json().data).toHaveLength(0);
  });

  it("rejects an upsert with an unknown field", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/admin/models/site-policies",
      payload: { siteId: "site-a", labelKey: "chat.premium", status: "hidden", junk: 1 },
    });
    expect(response.statusCode).toBe(400);
  });

  it("hidden policy excludes the label for that site only", async () => {
    await seedChatBindings();

    await app.inject({
      method: "POST",
      url: "/admin/models/site-policies",
      payload: { siteId: "site-a", labelKey: "chat.premium", status: "hidden" },
    });

    // site-a: gpt-4o carries chat.premium (hidden) → excluded; mini stays.
    const siteA = await app.inject({
      method: "GET",
      url: "/model-bindings/resolve?featureKey=chat",
      headers: { "x-kokoro-site-id": "site-a" },
    });
    expect(siteA.json().data.map((row: { modelName: string }) => row.modelName)).toEqual([
      "gpt-4o-mini",
    ]);

    // site-b: no policy → both visible.
    const siteB = await app.inject({
      method: "GET",
      url: "/model-bindings/resolve?featureKey=chat",
      headers: { "x-kokoro-site-id": "site-b" },
    });
    expect(siteB.json().data.map((row: { modelName: string }) => row.modelName).sort()).toEqual([
      "gpt-4o",
      "gpt-4o-mini",
    ]);

    // no site header → legacy behaviour, no filtering.
    const noSite = await app.inject({
      method: "GET",
      url: "/model-bindings/resolve?featureKey=chat",
    });
    expect(noSite.json().data.map((row: { modelName: string }) => row.modelName).sort()).toEqual([
      "gpt-4o",
      "gpt-4o-mini",
    ]);
  });

  it("visible policy does not hide the label", async () => {
    await seedChatBindings();

    await app.inject({
      method: "POST",
      url: "/admin/models/site-policies",
      payload: { siteId: "site-a", labelKey: "chat.premium", status: "visible" },
    });

    const siteA = await app.inject({
      method: "GET",
      url: "/model-bindings/resolve?featureKey=chat",
      headers: { "x-kokoro-site-id": "site-a" },
    });
    expect(siteA.json().data.map((row: { modelName: string }) => row.modelName).sort()).toEqual([
      "gpt-4o",
      "gpt-4o-mini",
    ]);
  });
});
