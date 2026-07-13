import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "../../generated/prisma/index.js";
import { SiteService } from "../../src/application/site-service.js";
import { createPrismaClient } from "../../src/infrastructure/prisma/prisma-client.js";
import { PrismaSiteRepository } from "../../src/infrastructure/prisma/prisma-site-repository.js";
import { createSiteServer } from "../../src/interfaces/http/server.js";

// WHY: needs a real MySQL bound to DATABASE_URL_SITE; exercises feature-flag routes + service over real HTTP.
function createTestPrismaClient(): PrismaClient {
  if (!process.env.DATABASE_URL_SITE) {
    throw new Error("DATABASE_URL_SITE is required for integration tests");
  }

  return createPrismaClient(process.env.DATABASE_URL_SITE);
}

async function reset(prisma: PrismaClient): Promise<void> {
  await prisma.siteFeatureFlag.deleteMany();
  await prisma.sitePolicy.deleteMany();
  await prisma.siteApp.deleteMany();
  await prisma.siteDomain.deleteMany();
  await prisma.site.deleteMany();
}

const prisma = createTestPrismaClient();
const app = createSiteServer({ prisma });
// 本套件只测 feature-flag 投影，不触域名验证：注入 no-op verifier。
const service = new SiteService(new PrismaSiteRepository(prisma), { lookupTxt: async () => [] });

async function createSite(key: string): Promise<string> {
  const site = await app.inject({
    method: "POST",
    url: "/sites/upsert",
    payload: { key, name: key, status: "active" },
  });
  return site.json().data.id as string;
}

describe("site feature flags", () => {
  beforeEach(async () => {
    await reset(prisma);
  });

  afterAll(async () => {
    await reset(prisma);
    await app.close();
    await prisma.$disconnect();
  });

  it("upserts a flag, toggles it, and lists it back per site", async () => {
    const siteId = await createSite("acme");

    const created = await app.inject({
      method: "POST",
      url: "/site-feature-flags/upsert",
      payload: { siteId, key: "video", enabled: true, metadata: { rolloutPct: 50 } },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().data.key).toBe("video");
    expect(created.json().data.enabled).toBe(true);
    expect(created.json().data.metadata).toEqual({ rolloutPct: 50 });
    const flagId = created.json().data.id as string;

    const toggled = await app.inject({
      method: "POST",
      url: "/site-feature-flags/upsert",
      payload: { siteId, key: "video", enabled: false },
    });
    expect(toggled.statusCode).toBe(200);
    expect(toggled.json().data.id).toBe(flagId);
    expect(toggled.json().data.enabled).toBe(false);

    const list = await app.inject({
      method: "GET",
      url: "/site-feature-flags",
      query: { siteId },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toHaveLength(1);
    expect(list.json().data[0].id).toBe(flagId);
  });

  it("reads siteId from the x-kokoro-site-id header when query omits it", async () => {
    const siteId = await createSite("acme");
    await app.inject({
      method: "POST",
      url: "/site-feature-flags/upsert",
      payload: { siteId, key: "image", enabled: true },
    });

    const list = await app.inject({
      method: "GET",
      url: "/site-feature-flags",
      headers: { "x-kokoro-site-id": siteId },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toHaveLength(1);
    expect(list.json().data[0].key).toBe("image");
  });

  it("isolates flags across sites (one site cannot see another's)", async () => {
    const acme = await createSite("acme");
    const beta = await createSite("beta");

    await app.inject({
      method: "POST",
      url: "/site-feature-flags/upsert",
      payload: { siteId: acme, key: "video", enabled: true },
    });
    await app.inject({
      method: "POST",
      url: "/site-feature-flags/upsert",
      payload: { siteId: beta, key: "image", enabled: false },
    });

    const acmeList = await app.inject({ method: "GET", url: "/site-feature-flags", query: { siteId: acme } });
    expect(acmeList.json().data.map((f: { key: string }) => f.key)).toEqual(["video"]);

    const betaList = await app.inject({ method: "GET", url: "/site-feature-flags", query: { siteId: beta } });
    expect(betaList.json().data.map((f: { key: string }) => f.key)).toEqual(["image"]);

    const acmeFlags = await service.resolveFlags(acme);
    expect(acmeFlags).toEqual({ video: true });

    const betaFlags = await service.resolveFlags(beta);
    expect(betaFlags).toEqual({ image: false });
  });

  it("rejects unknown fields on upsert with a 400 (.strict)", async () => {
    const siteId = await createSite("acme");
    const response = await app.inject({
      method: "POST",
      url: "/site-feature-flags/upsert",
      payload: { siteId, key: "video", enabled: true, bogus: "x" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("request.invalid");
  });

  it("rejects a list with no siteId (query nor header) with a 400", async () => {
    const response = await app.inject({ method: "GET", url: "/site-feature-flags" });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("request.invalid");
  });
});
