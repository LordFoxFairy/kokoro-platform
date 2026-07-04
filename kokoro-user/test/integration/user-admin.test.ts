import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createUserServer } from "../../src/interfaces/http/server.js";
import { cleanUserDatabase, createTestPrismaClient } from "./helpers.js";

const prisma = createTestPrismaClient();
const app = createUserServer({ prisma });

// 单个共享 app 在所有 describe 跑完后关闭一次，避免第二个 describe 复用已关闭实例。
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

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
      headers: { "x-kokoro-site-id": "site-a" },
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
      headers: { "x-kokoro-site-id": "site-a" },
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

  it("includes deleted rows in admin lists for restore workflows", async () => {
    const ensured = await app.inject({
      method: "POST",
      url: "/users/ensure",
      headers: { "x-kokoro-site-id": "site-a" },
      payload: { externalUserId: "auth0|admin-deleted", displayName: "Admin Deleted" },
    });
    const { user, personalTeam } = ensured.json().data;

    await app.inject({
      method: "DELETE",
      url: `/users/${user.id}`,
      payload: { deletedBy: "operator-1", reason: "closed" },
    });

    const users = await app.inject({ method: "GET", url: "/admin/users" });
    expect(users.statusCode).toBe(200);
    expect(users.json().data).toContainEqual(expect.objectContaining({ id: user.id, deletedBy: "operator-1" }));

    const teams = await app.inject({ method: "GET", url: "/admin/teams" });
    expect(teams.statusCode).toBe(200);
    expect(teams.json().data).toContainEqual(expect.objectContaining({ id: personalTeam.id, deletedBy: "operator-1" }));
  });
});

describe("user admin disable/enable", () => {
  beforeEach(async () => {
    await cleanUserDatabase(prisma);
  });

  async function seedUser(externalUserId: string): Promise<string> {
    const ensured = await app.inject({
      method: "POST",
      url: "/users/ensure",
      headers: { "x-kokoro-site-id": "site-a" },
      payload: { externalUserId, displayName: "Target" },
    });
    return ensured.json().data.user.id;
  }

  it("disable sets status=disabled with a non-null disabledAt", async () => {
    const userId = await seedUser("auth0|disable-me");

    const response = await app.inject({ method: "POST", url: `/admin/users/${userId}/disable` });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe("disabled");
    expect(response.json().data.disabledAt).not.toBeNull();
  });

  it("is idempotent: disabling an already-disabled user stays disabled", async () => {
    const userId = await seedUser("auth0|disable-twice");

    await app.inject({ method: "POST", url: `/admin/users/${userId}/disable` });
    const second = await app.inject({ method: "POST", url: `/admin/users/${userId}/disable` });

    expect(second.statusCode).toBe(200);
    expect(second.json().data.status).toBe("disabled");
    expect(second.json().data.disabledAt).not.toBeNull();
  });

  it("ensure does not revive a disabled user (companion to the upsert fix)", async () => {
    const externalUserId = "auth0|no-revive";
    const userId = await seedUser(externalUserId);

    await app.inject({ method: "POST", url: `/admin/users/${userId}/disable` });

    // 同一 externalUserId 再 ensure，只刷资料，status 必须仍为 disabled。
    const reEnsured = await app.inject({
      method: "POST",
      url: "/users/ensure",
      headers: { "x-kokoro-site-id": "site-a" },
      payload: { externalUserId, displayName: "Target Updated" },
    });

    expect(reEnsured.statusCode).toBe(200);
    expect(reEnsured.json().data.user.status).toBe("disabled");
  });

  it("enable restores status=active and clears disabledAt", async () => {
    const userId = await seedUser("auth0|enable-me");

    await app.inject({ method: "POST", url: `/admin/users/${userId}/disable` });
    const enabled = await app.inject({ method: "POST", url: `/admin/users/${userId}/enable` });

    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().data.status).toBe("active");
    expect(enabled.json().data.disabledAt).toBeNull();
  });

  it("enable is idempotent on an already-active user", async () => {
    const userId = await seedUser("auth0|enable-twice");

    const enabled = await app.inject({ method: "POST", url: `/admin/users/${userId}/enable` });

    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().data.status).toBe("active");
    expect(enabled.json().data.disabledAt).toBeNull();
  });

  it("returns 404 when disabling a non-existent user", async () => {
    const response = await app.inject({ method: "POST", url: "/admin/users/nope/disable" });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("user.not_found");
  });

  it("returns 404 when enabling a non-existent user", async () => {
    const response = await app.inject({ method: "POST", url: "/admin/users/nope/enable" });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("user.not_found");
  });
});
