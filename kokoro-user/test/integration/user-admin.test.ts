import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createUserServer } from "../../src/interfaces/http/server.js";
import { cleanUserDatabase, createTestPrismaClient } from "./helpers.js";

const prisma = createTestPrismaClient();
const app = createUserServer({ prisma });

const listRoutes = [
  "/admin/users",
  "/admin/teams",
  "/admin/memberships",
  "/admin/service-accounts",
] as const;

describe("user admin read-only API", () => {
  beforeEach(async () => {
    await cleanUserDatabase(prisma);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it("exposes the admin manifest", async () => {
    const response = await app.inject({ method: "GET", url: "/admin/users/manifest" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.id).toBe("kokoro-user");
    expect(body.data.basePath).toBe("/admin/users");
    expect(body.data.resources.map((r: { id: string }) => r.id)).toEqual([
      "users",
      "teams",
      "memberships",
      "service-accounts",
    ]);
  });

  it.each(listRoutes)("returns an empty array for %s when no data exists", async (url) => {
    const response = await app.inject({ method: "GET", url });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([]);
  });

  it("surfaces seeded users, teams and memberships", async () => {
    await app.inject({
      method: "POST",
      url: "/users/ensure",
      payload: {
        externalUserId: "auth0|admin-seed",
        email: "admin-seed@example.com",
        displayName: "Admin Seed",
      },
    });

    const users = await app.inject({ method: "GET", url: "/admin/users" });
    expect(users.statusCode).toBe(200);
    expect(users.json().data).toHaveLength(1);
    expect(users.json().data[0].externalUserId).toBe("auth0|admin-seed");

    const teams = await app.inject({ method: "GET", url: "/admin/teams" });
    expect(teams.json().data).toHaveLength(1);
    expect(teams.json().data[0].type).toBe("personal");

    const memberships = await app.inject({ method: "GET", url: "/admin/memberships" });
    expect(memberships.json().data).toHaveLength(1);
    expect(memberships.json().data[0].role).toBe("owner");
  });

  it("surfaces seeded service accounts", async () => {
    const ensured = await app.inject({
      method: "POST",
      url: "/users/ensure",
      payload: { externalUserId: "auth0|sa-owner", displayName: "SA Owner" },
    });
    const ownerUserId = ensured.json().data.user.id;
    const teamId = ensured.json().data.personalTeam.id;

    await prisma.serviceAccount.create({
      data: {
        teamId,
        ownerUserId,
        name: "ci-bot",
        tokenPrefix: "sk_test",
        secretHash: "hash",
      },
    });

    const response = await app.inject({ method: "GET", url: "/admin/service-accounts" });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(1);
    expect(response.json().data[0].name).toBe("ci-bot");
    expect(response.json().data[0].tokenPrefix).toBe("sk_test");
  });
});
