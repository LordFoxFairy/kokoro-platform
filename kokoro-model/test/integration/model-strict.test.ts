import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createModelServer } from "../../src/interfaces/http/server.js";
import { cleanModelDatabase, createTestPrismaClient } from "./helpers.js";

const prisma = createTestPrismaClient();
const app = createModelServer({ prisma });

async function ensureAccount(key: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/provider-accounts/ensure",
    payload: { provider: "openai", key, label: "OpenAI", secretRef: `secret://openai/${key}`, transportKind: "direct" },
  });
  const id: string = res.json().data.id;
  return id;
}

describe("model HTTP strict boundary & idempotency", () => {
  beforeEach(async () => {
    await cleanModelDatabase(prisma);
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it("rejects unknown fields on provider-accounts/ensure with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/provider-accounts/ensure",
      payload: { provider: "openai", key: "k", label: "l", secretRef: "s", transportKind: "direct", bogus: 1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects invalid transportKind with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/provider-accounts/ensure",
      payload: { provider: "openai", key: "k", label: "l", secretRef: "s", transportKind: "grpc" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects unknown fields on model-bindings/ensure with 400", async () => {
    const providerAccountId = await ensureAccount("strict_binding");
    const res = await app.inject({
      method: "POST",
      url: "/model-bindings/ensure",
      payload: {
        providerAccountId,
        modelName: "gpt-4o",
        displayName: "GPT-4o",
        featureKey: "chat",
        transportKind: "direct",
        junk: true,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects unknown query params on model-bindings list with 400", async () => {
    const res = await app.inject({ method: "GET", url: "/model-bindings?featureKey=chat&junk=1" });
    expect(res.statusCode).toBe(400);
  });

  it("upserts binding idempotently on repeated ensure", async () => {
    const providerAccountId = await ensureAccount("idem_binding");
    const payload = {
      providerAccountId,
      modelName: "gpt-4o",
      displayName: "GPT-4o",
      featureKey: "chat",
      transportKind: "direct",
    };

    const first = await app.inject({ method: "POST", url: "/model-bindings/ensure", payload });
    const second = await app.inject({
      method: "POST",
      url: "/model-bindings/ensure",
      payload: { ...payload, displayName: "GPT-4o (updated)" },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().data.id).toBe(first.json().data.id);
    expect(second.json().data.displayName).toBe("GPT-4o (updated)");
  });
});
