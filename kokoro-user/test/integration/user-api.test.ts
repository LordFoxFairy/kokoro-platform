import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createUserServer } from "../../src/interfaces/http/server.js";
import { cleanUserDatabase, createTestPrismaClient } from "./helpers.js";

const prisma = createTestPrismaClient();
const app = createUserServer({ prisma });

describe("user HTTP API", () => {
  beforeEach(async () => {
    await cleanUserDatabase(prisma);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it("returns module health", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/healthz",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        module: "user",
        status: "ok",
      },
    });
  });

  it("exposes owner active over HTTP for user and team owners", async () => {
    const ensured = await app.inject({
      method: "POST",
      url: "/users/ensure",
      headers: { "x-request-id": "req_oa", "x-kokoro-site-id": "site-a" },
      payload: { externalUserId: "auth0|owner-active-http", email: "oa@example.com", displayName: "OA" },
    });
    const { user, personalTeam } = ensured.json().data;

    const userActive = await app.inject({
      method: "GET",
      url: `/owners/user/${user.id}/active`,
      headers: { "x-kokoro-site-id": "site-a" },
    });
    expect(userActive.statusCode).toBe(200);
    expect(userActive.json().data).toEqual({ active: true });

    const teamActive = await app.inject({
      method: "GET",
      url: `/owners/team/${personalTeam.id}/active`,
      headers: { "x-kokoro-site-id": "site-a" },
    });
    expect(teamActive.json().data).toEqual({ active: true });

    const missing = await app.inject({
      method: "GET",
      url: "/owners/user/nope/active",
      headers: { "x-kokoro-site-id": "site-a" },
    });
    expect(missing.json().data).toEqual({ active: false });

    const noSite = await app.inject({ method: "GET", url: `/owners/user/${user.id}/active` });
    expect(noSite.statusCode).toBe(400);
  });

  it("deletes and restores a user over HTTP", async () => {
    const ensured = await app.inject({
      method: "POST",
      url: "/users/ensure",
      headers: { "x-kokoro-site-id": "site-a" },
      payload: { externalUserId: "auth0|delete-user-http", displayName: "Delete User" },
    });
    const { user } = ensured.json().data;

    const deleted = await app.inject({
      method: "DELETE",
      url: `/users/${user.id}`,
      payload: { deletedBy: "operator-1", reason: "closed" },
    });

    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().data.deletedBy).toBe("operator-1");
    expect(deleted.json().data.deleteReason).toBe("closed");
    expect(deleted.json().data.deletedAt).toEqual(expect.any(String));

    const inactive = await app.inject({
      method: "GET",
      url: `/owners/user/${user.id}/active`,
      headers: { "x-kokoro-site-id": "site-a" },
    });
    expect(inactive.json().data).toEqual({ active: false });

    const restored = await app.inject({
      method: "POST",
      url: `/users/${user.id}/restore`,
    });

    expect(restored.statusCode).toBe(200);
    expect(restored.json().data.deletedAt).toBeNull();

    const active = await app.inject({
      method: "GET",
      url: `/owners/user/${user.id}/active`,
      headers: { "x-kokoro-site-id": "site-a" },
    });
    expect(active.json().data).toEqual({ active: true });
  });

  it("deletes and restores a team over HTTP", async () => {
    const ensured = await app.inject({
      method: "POST",
      url: "/users/ensure",
      headers: { "x-kokoro-site-id": "site-a" },
      payload: { externalUserId: "auth0|team-delete-owner", displayName: "Team Owner" },
    });
    const { user } = ensured.json().data;
    const created = await app.inject({
      method: "POST",
      url: "/teams/upsert",
      headers: { "x-kokoro-site-id": "site-a" },
      payload: { slug: "delete-team-http", name: "Delete Team", ownerUserId: user.id },
    });
    const team = created.json().data;

    const deleted = await app.inject({
      method: "DELETE",
      url: `/teams/${team.id}`,
      payload: { deletedBy: "operator-1", reason: "retired" },
    });

    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().data.deletedAt).toEqual(expect.any(String));

    const inactive = await app.inject({
      method: "GET",
      url: `/owners/team/${team.id}/active`,
      headers: { "x-kokoro-site-id": "site-a" },
    });
    expect(inactive.json().data).toEqual({ active: false });

    const restored = await app.inject({
      method: "POST",
      url: `/teams/${team.id}/restore`,
    });

    expect(restored.statusCode).toBe(200);
    expect(restored.json().data.deletedAt).toBeNull();

    const active = await app.inject({
      method: "GET",
      url: `/owners/team/${team.id}/active`,
      headers: { "x-kokoro-site-id": "site-a" },
    });
    expect(active.json().data).toEqual({ active: true });
  });

  it("rejects a deleted owner in team upsert over HTTP", async () => {
    const ensured = await app.inject({
      method: "POST",
      url: "/users/ensure",
      headers: { "x-kokoro-site-id": "site-a" },
      payload: { externalUserId: "auth0|deleted-owner-http", displayName: "Deleted Owner" },
    });
    const { user } = ensured.json().data;
    await app.inject({
      method: "DELETE",
      url: `/users/${user.id}`,
      payload: { deletedBy: "operator-1", reason: "closed" },
    });

    const response = await app.inject({
      method: "POST",
      url: "/teams/upsert",
      headers: { "x-kokoro-site-id": "site-a" },
      payload: { slug: "deleted-owner-team", name: "Deleted Owner Team", ownerUserId: user.id },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: {
        code: "user.deleted",
      },
    });
  });

  it("ensures a user with a personal team", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/users/ensure",
      headers: {
        "x-request-id": "req_api_1",
        "x-kokoro-site-id": "site-a",
      },
      payload: {
        externalUserId: "auth0|api-user",
        email: "api@example.com",
        displayName: "Api User",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.requestId).toBe("req_api_1");
    expect(body.data.user.siteId).toBe("site-a");
    expect(body.data.user.externalUserId).toBe("auth0|api-user");
    expect(body.data.personalTeam.siteId).toBe("site-a");
    expect(body.data.personalTeam.type).toBe("personal");
    expect(body.data.membership.role).toBe("owner");
  });

  it("rejects ensure without a site context header", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/users/ensure",
      headers: {
        "x-request-id": "req_no_site",
      },
      payload: {
        externalUserId: "auth0|no-site",
        displayName: "No Site",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      requestId: "req_no_site",
      error: {
        code: "context.site_required",
      },
    });
  });

  it("isolates the same external user across sites", async () => {
    const onA = await app.inject({
      method: "POST",
      url: "/users/ensure",
      headers: { "x-kokoro-site-id": "site-a" },
      payload: { externalUserId: "auth0|cross-site", displayName: "Cross" },
    });
    const onB = await app.inject({
      method: "POST",
      url: "/users/ensure",
      headers: { "x-kokoro-site-id": "site-b" },
      payload: { externalUserId: "auth0|cross-site", displayName: "Cross" },
    });

    expect(onA.statusCode).toBe(200);
    expect(onB.statusCode).toBe(200);
    expect(onA.json().data.user.id).not.toBe(onB.json().data.user.id);
    expect(onA.json().data.user.siteId).toBe("site-a");
    expect(onB.json().data.user.siteId).toBe("site-b");
  });

  it("returns a stable personal team for repeated ensure requests", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/users/ensure",
      headers: { "x-kokoro-site-id": "site-a" },
      payload: {
        externalUserId: "auth0|same-user",
        displayName: "Same User",
      },
    });

    const second = await app.inject({
      method: "POST",
      url: "/users/ensure",
      headers: { "x-kokoro-site-id": "site-a" },
      payload: {
        externalUserId: "auth0|same-user",
        displayName: "Same User Updated",
      },
    });

    expect(second.statusCode).toBe(200);
    expect(second.json().data.user.id).toBe(first.json().data.user.id);
    expect(second.json().data.personalTeam.id).toBe(first.json().data.personalTeam.id);
  });

  it("returns a typed error for invalid requests", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/users/ensure",
      headers: {
        "x-request-id": "req_invalid",
        "x-kokoro-site-id": "site-a",
      },
      payload: {
        email: "not-an-external-id@example.com",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      requestId: "req_invalid",
      error: {
        code: "request.invalid",
      },
    });
  });

  it("requires a non-empty user id header when listing teams", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/me/teams",
      headers: {
        "x-request-id": "req_missing_user",
        "x-user-id": "   ",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      requestId: "req_missing_user",
      error: {
        code: "request.missing_user",
      },
    });
  });
});
