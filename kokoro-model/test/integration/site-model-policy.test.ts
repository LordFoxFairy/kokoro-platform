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

// 目录读的是 modelLabel 表本身，与 binding 无关，所以单独播种。
async function seedChatLabels(): Promise<void> {
  await prisma.modelLabel.createMany({
    data: [
      { key: "chat.default", displayName: "Kokoro 默认", featureKey: "chat", status: "active" },
      { key: "chat.premium", displayName: "Kokoro 高级", featureKey: "chat", status: "active" },
    ],
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
      url: "/model-bindings/resolve?siteId=site-a&featureKey=chat",
    });
    expect(siteA.statusCode).toBe(200);
    expect(siteA.json().data.map((row: { modelName: string }) => row.modelName)).toEqual([
      "gpt-4o-mini",
    ]);

    // site-b: no policy → both visible.
    const siteB = await app.inject({
      method: "GET",
      url: "/model-bindings/resolve?siteId=site-b&featureKey=chat",
    });
    expect(siteB.json().data.map((row: { modelName: string }) => row.modelName).sort()).toEqual([
      "gpt-4o",
      "gpt-4o-mini",
    ]);
  });

  // 回归：修复前 siteId 取自可空 header，省略即「不按站过滤」，调用方能拿到该站已隐藏的 label。
  // 现在 siteId 是必填 query，缺失被 schema 拒绝——「不过滤」这条路不再存在。
  it("rejects resolve without siteId instead of returning unfiltered bindings", async () => {
    await seedChatBindings();

    await app.inject({
      method: "POST",
      url: "/admin/models/site-policies",
      payload: { siteId: "site-a", labelKey: "chat.premium", status: "hidden" },
    });

    const noSite = await app.inject({
      method: "GET",
      url: "/model-bindings/resolve?featureKey=chat",
    });
    expect(noSite.statusCode).toBe(400);
    expect(noSite.json().error.code).toBe("request.invalid");

    // 发 header 也不行：header 不是权威来源，不能替代 query 参数。
    const headerOnly = await app.inject({
      method: "GET",
      url: "/model-bindings/resolve?featureKey=chat",
      headers: { "x-kokoro-site-id": "site-a" },
    });
    expect(headerOnly.statusCode).toBe(400);
    expect(headerOnly.json().error.code).toBe("request.invalid");
  });

  // header 与 query 都给且互相矛盾 = 调用方身份混淆，两边都不可信 → 硬拒，不挑一个信。
  it("rejects a site header that contradicts the query siteId", async () => {
    await seedChatBindings();

    const mismatch = await app.inject({
      method: "GET",
      url: "/model-bindings/resolve?siteId=site-a&featureKey=chat",
      headers: { "x-kokoro-site-id": "site-b" },
    });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().error.code).toBe("model.site_mismatch");

    // 一致则放行。
    const agreeing = await app.inject({
      method: "GET",
      url: "/model-bindings/resolve?siteId=site-a&featureKey=chat",
      headers: { "x-kokoro-site-id": "site-a" },
    });
    expect(agreeing.statusCode).toBe(200);
  });

  // 目录与 resolve 必须对同一站点给出一致答案：目录若列出该站已隐藏的 label，
  // 用户能选中一个 resolve 必然拒绝的模型。修复前目录完全不按站点过滤。
  it("catalogue hides the same labels resolve hides, per site", async () => {
    await seedChatLabels();

    await app.inject({
      method: "POST",
      url: "/admin/models/site-policies",
      payload: { siteId: "site-a", labelKey: "chat.premium", status: "hidden" },
    });

    const siteA = await app.inject({ method: "GET", url: "/model-labels?siteId=site-a&featureKey=chat" });
    expect(siteA.statusCode).toBe(200);
    expect(siteA.json().data.map((row: { key: string }) => row.key)).toEqual(["chat.default"]);

    // site-b 无策略 → 两个都可见，证明过滤按站点而非全局。
    const siteB = await app.inject({ method: "GET", url: "/model-labels?siteId=site-b&featureKey=chat" });
    expect(siteB.json().data.map((row: { key: string }) => row.key).sort()).toEqual([
      "chat.default",
      "chat.premium",
    ]);
  });

  // 回归：修复前 siteId 不是目录的参数，省略即「不按站过滤」。现在缺失被 schema 拒绝。
  it("rejects a catalogue request without siteId instead of returning every label", async () => {
    await seedChatLabels();

    await app.inject({
      method: "POST",
      url: "/admin/models/site-policies",
      payload: { siteId: "site-a", labelKey: "chat.premium", status: "hidden" },
    });

    const noSite = await app.inject({ method: "GET", url: "/model-labels?featureKey=chat" });
    expect(noSite.statusCode).toBe(400);
    expect(noSite.json().error.code).toBe("request.invalid");

    // 只发 header 同样不行：header 不是权威来源。修复前 session 正是只发 header，服务端整个忽略。
    const headerOnly = await app.inject({
      method: "GET",
      url: "/model-labels?featureKey=chat",
      headers: { "x-kokoro-site-id": "site-a" },
    });
    expect(headerOnly.statusCode).toBe(400);
    expect(headerOnly.json().error.code).toBe("request.invalid");
  });

  it("rejects a catalogue site header that contradicts the query siteId", async () => {
    await seedChatLabels();

    const mismatch = await app.inject({
      method: "GET",
      url: "/model-labels?siteId=site-a&featureKey=chat",
      headers: { "x-kokoro-site-id": "site-b" },
    });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().error.code).toBe("model.site_mismatch");
  });

  // 目录只出 active：disabled 的 label 不该进用户选择器，与站点策略正交。
  it("catalogue excludes disabled labels and filters by featureKey", async () => {
    await seedChatLabels();
    await prisma.modelLabel.createMany({
      data: [
        { key: "chat.retired", displayName: "Retired", featureKey: "chat", status: "disabled" },
        { key: "embed.default", displayName: "Embedding", featureKey: "embedding", status: "active" },
      ],
    });

    const chat = await app.inject({ method: "GET", url: "/model-labels?siteId=site-a&featureKey=chat" });
    expect(chat.json().data.map((row: { key: string }) => row.key).sort()).toEqual([
      "chat.default",
      "chat.premium",
    ]);

    // 不带 featureKey = 跨 feature，但仍然只出 active。
    const all = await app.inject({ method: "GET", url: "/model-labels?siteId=site-a" });
    expect(all.json().data.map((row: { key: string }) => row.key).sort()).toEqual([
      "chat.default",
      "chat.premium",
      "embed.default",
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
      url: "/model-bindings/resolve?siteId=site-a&featureKey=chat",
    });
    expect(siteA.json().data.map((row: { modelName: string }) => row.modelName).sort()).toEqual([
      "gpt-4o",
      "gpt-4o-mini",
    ]);
  });
});
