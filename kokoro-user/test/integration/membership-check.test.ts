import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createUserServer } from "../../src/interfaces/http/server.js";
import { cleanUserDatabase, createTestPrismaClient } from "./helpers.js";

// hub self 面授权窄口（HUB-AUTHZ）：GET /memberships/check?teamId=&userId= → {active, role}。
const prisma = createTestPrismaClient();
const app = createUserServer({ prisma });

async function ensureUser(externalUserId: string): Promise<{ userId: string; personalTeamId: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/users/ensure",
    headers: { "x-kokoro-site-id": "site-a" },
    payload: { externalUserId, displayName: externalUserId },
  });
  const data = res.json().data;
  return { userId: data.user.id, personalTeamId: data.personalTeam.id };
}

describe("membership check narrow interface", () => {
  beforeEach(async () => {
    await cleanUserDatabase(prisma);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it("returns active owner for a personal-team owner", async () => {
    const { userId, personalTeamId } = await ensureUser("auth0|check-owner");

    const res = await app.inject({
      method: "GET",
      url: "/memberships/check",
      query: { teamId: personalTeamId, userId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ active: true, role: "owner" });
  });

  it("returns the assigned role for a non-owner member", async () => {
    const owner = await ensureUser("auth0|check-team-owner");
    const member = await ensureUser("auth0|check-team-member");

    const team = await app.inject({
      method: "POST",
      url: "/teams/upsert",
      headers: { "x-kokoro-site-id": "site-a" },
      payload: { slug: "check-team", name: "Check Team", ownerUserId: owner.userId },
    });
    const teamId = team.json().data.id;

    await app.inject({
      method: "POST",
      url: "/memberships/change-role",
      payload: { teamId, userId: member.userId, role: "member" },
    });

    const res = await app.inject({
      method: "GET",
      url: "/memberships/check",
      query: { teamId, userId: member.userId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ active: true, role: "member" });
  });

  it("returns inactive for a valid user with no membership in the team", async () => {
    const owner = await ensureUser("auth0|check-nonmember-owner");
    const stranger = await ensureUser("auth0|check-stranger");

    const res = await app.inject({
      method: "GET",
      url: "/memberships/check",
      query: { teamId: owner.personalTeamId, userId: stranger.userId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ active: false, role: null });
  });

  it("fail-closes to inactive when the team is deleted", async () => {
    const owner = await ensureUser("auth0|check-owner-deleted");
    const member = await ensureUser("auth0|check-member-deleted");

    const team = await app.inject({
      method: "POST",
      url: "/teams/upsert",
      headers: { "x-kokoro-site-id": "site-a" },
      payload: { slug: "check-team-deleted", name: "Deleted Team", ownerUserId: owner.userId },
    });
    const teamId = team.json().data.id;
    await app.inject({
      method: "POST",
      url: "/memberships/change-role",
      payload: { teamId, userId: member.userId, role: "admin" },
    });

    await app.inject({
      method: "DELETE",
      url: `/teams/${teamId}`,
      payload: { deletedBy: "operator-1", reason: "retired" },
    });

    const res = await app.inject({
      method: "GET",
      url: "/memberships/check",
      query: { teamId, userId: member.userId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ active: false, role: null });
  });

  it("rejects a check without a teamId query", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/memberships/check",
      query: { userId: "u1" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("request.invalid");
  });
});
