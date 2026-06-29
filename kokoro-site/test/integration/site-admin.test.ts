import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "../../generated/prisma/index.js";
import { createPrismaClient } from "../../src/infrastructure/prisma/prisma-client.js";
import { siteAdminManifest } from "../../src/interfaces/admin/manifest.js";
import { createSiteServer } from "../../src/interfaces/http/server.js";

// WHY: needs a real MySQL bound to DATABASE_URL_SITE; exercises admin-routes.ts over real HTTP.
function createTestPrismaClient(): PrismaClient {
  if (!process.env.DATABASE_URL_SITE) {
    throw new Error("DATABASE_URL_SITE is required for integration tests");
  }

  return createPrismaClient(process.env.DATABASE_URL_SITE);
}

async function reset(prisma: PrismaClient): Promise<void> {
  await prisma.sitePolicy.deleteMany();
  await prisma.siteApp.deleteMany();
  await prisma.siteDomain.deleteMany();
  await prisma.site.deleteMany();
}

const prisma = createTestPrismaClient();
const app = createSiteServer({ prisma });

const resourceRouteById = new Map(siteAdminManifest.resources.map((r) => [r.id, r.route]));

async function seed(): Promise<void> {
  const site = await app.inject({
    method: "POST",
    url: "/sites/upsert",
    payload: { key: "acme", name: "Acme", status: "active" },
  });
  const siteId = site.json().data.id as string;

  await app.inject({
    method: "POST",
    url: "/site-domains/upsert",
    payload: { siteId, host: "acme.com", status: "active", isPrimary: true },
  });
  await app.inject({
    method: "POST",
    url: "/site-apps/upsert",
    payload: { siteId, appKey: "web", surface: "general", status: "active" },
  });
  await app.inject({
    method: "POST",
    url: "/site-policies/upsert",
    payload: { siteId, key: "rate", value: { rpm: 60 } },
  });
}

describe("site admin read-only API", () => {
  beforeEach(async () => {
    await reset(prisma);
  });

  afterAll(async () => {
    await reset(prisma);
    await app.close();
    await prisma.$disconnect();
  });

  it("serves the admin manifest (200)", async () => {
    const response = await app.inject({
      method: "GET",
      url: `${siteAdminManifest.basePath}/manifest`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.id).toBe("kokoro-site");
    expect(response.json().data.resources).toHaveLength(siteAdminManifest.resources.length);
  });

  it("returns an empty array for each resource list when no data (200)", async () => {
    for (const resource of siteAdminManifest.resources) {
      const response = await app.inject({ method: "GET", url: resource.route });
      expect(response.statusCode).toBe(200);
      expect(Array.isArray(response.json().data)).toBe(true);
      expect(response.json().data).toHaveLength(0);
    }
  });

  it("surfaces seeded rows on each resource list (200)", async () => {
    await seed();

    for (const resource of siteAdminManifest.resources) {
      const response = await app.inject({ method: "GET", url: resource.route });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toHaveLength(1);
    }
  });

  it("returns the seeded policy value verbatim", async () => {
    await seed();

    const route = resourceRouteById.get("policies");
    expect(route).toBeDefined();
    const response = await app.inject({ method: "GET", url: route as string });
    expect(response.statusCode).toBe(200);
    expect(response.json().data[0].key).toBe("rate");
    expect(response.json().data[0].value).toEqual({ rpm: 60 });
  });
});
