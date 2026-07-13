import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createUserServer } from "../../src/interfaces/http/server.js";
import { cleanUserDatabase, createTestPrismaClient } from "./helpers.js";

// 团队自助竖切（TEAM-1）：邀请/成员/换签/离队。web BFF 携 user principal（x-user-id）调用 /bff/*。
const prisma = createTestPrismaClient();
const app = createUserServer({
  prisma,
  sessionSigning: { secret: "team-flow-secret", ttlSeconds: 3600, issuer: "kokoro-user" },
});

async function ensureUser(
  externalUserId: string,
  email: string,
): Promise<{ userId: string; personalTeamId: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/users/ensure",
    headers: { "x-kokoro-site-id": "site-a" },
    payload: { externalUserId, email, displayName: externalUserId },
  });
  const data = res.json().data;
  return { userId: data.user.id, personalTeamId: data.personalTeam.id };
}

async function makeTeam(ownerUserId: string, slug: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/teams/upsert",
    headers: { "x-kokoro-site-id": "site-a" },
    payload: { slug, name: `Team ${slug}`, ownerUserId },
  });
  return res.json().data.id;
}

function bff(method: "GET" | "POST", url: string, userId: string, payload?: unknown) {
  return app.inject({ method, url, headers: { "x-user-id": userId }, ...(payload ? { payload } : {}) });
}

describe("team self-service flow", () => {
  beforeEach(async () => {
    await cleanUserDatabase(prisma);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it("invites, lists, accepts and reflects membership in the hub check", async () => {
    const owner = await ensureUser("auth0|owner-1", "owner1@example.com");
    const invitee = await ensureUser("auth0|invitee-1", "invitee1@example.com");
    const teamId = await makeTeam(owner.userId, "acme");

    const invited = await bff("POST", `/bff/teams/${teamId}/invites`, owner.userId, {
      email: "invitee1@example.com",
      role: "member",
    });
    expect(invited.statusCode).toBe(200);
    const inviteId = invited.json().data.id;

    const pending = await bff("GET", "/bff/me/invites", invitee.userId);
    expect(pending.statusCode).toBe(200);
    expect(pending.json().data).toHaveLength(1);
    expect(pending.json().data[0]).toMatchObject({ id: inviteId, teamId, role: "member" });

    const accepted = await bff("POST", `/bff/invites/${inviteId}/accept`, invitee.userId);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().data.membership).toMatchObject({ teamId, userId: invitee.userId, role: "member" });

    const check = await app.inject({
      method: "GET",
      url: "/memberships/check",
      query: { teamId, userId: invitee.userId },
    });
    expect(check.json().data).toEqual({ active: true, role: "member" });

    // 接受后不再是 pending。
    const pendingAfter = await bff("GET", "/bff/me/invites", invitee.userId);
    expect(pendingAfter.json().data).toHaveLength(0);
  });

  it("is idempotent on repeated accept", async () => {
    const owner = await ensureUser("auth0|owner-2", "owner2@example.com");
    const invitee = await ensureUser("auth0|invitee-2", "invitee2@example.com");
    const teamId = await makeTeam(owner.userId, "beta");
    const invited = await bff("POST", `/bff/teams/${teamId}/invites`, owner.userId, {
      email: "invitee2@example.com",
      role: "admin",
    });
    const inviteId = invited.json().data.id;

    const first = await bff("POST", `/bff/invites/${inviteId}/accept`, invitee.userId);
    const second = await bff("POST", `/bff/invites/${inviteId}/accept`, invitee.userId);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().data.membership).toMatchObject({ role: "admin" });
  });

  it("rejects an expired invite", async () => {
    const owner = await ensureUser("auth0|owner-3", "owner3@example.com");
    const invitee = await ensureUser("auth0|invitee-3", "invitee3@example.com");
    const teamId = await makeTeam(owner.userId, "gamma");
    const invited = await bff("POST", `/bff/teams/${teamId}/invites`, owner.userId, {
      email: "invitee3@example.com",
      role: "member",
    });
    const inviteId = invited.json().data.id;
    // 直接把过期时间挪到过去，绕过 TTL 恒为未来。
    await prisma.invite.update({ where: { id: inviteId }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const accepted = await bff("POST", `/bff/invites/${inviteId}/accept`, invitee.userId);
    expect(accepted.statusCode).toBe(409);
    expect(accepted.json().error.code).toBe("invite.expired");
    // 过期链不出现在 pending 列表。
    const pending = await bff("GET", "/bff/me/invites", invitee.userId);
    expect(pending.json().data).toHaveLength(0);
  });

  it("declines an invite so it no longer appears pending", async () => {
    const owner = await ensureUser("auth0|owner-4", "owner4@example.com");
    const invitee = await ensureUser("auth0|invitee-4", "invitee4@example.com");
    const teamId = await makeTeam(owner.userId, "delta");
    const invited = await bff("POST", `/bff/teams/${teamId}/invites`, owner.userId, {
      email: "invitee4@example.com",
      role: "member",
    });
    const inviteId = invited.json().data.id;

    const declined = await bff("POST", `/bff/invites/${inviteId}/decline`, invitee.userId);
    expect(declined.statusCode).toBe(200);
    const pending = await bff("GET", "/bff/me/invites", invitee.userId);
    expect(pending.json().data).toHaveLength(0);
    // 已拒绝再接受 → not_pending。
    const accept = await bff("POST", `/bff/invites/${inviteId}/accept`, invitee.userId);
    expect(accept.statusCode).toBe(409);
    expect(accept.json().error.code).toBe("invite.not_pending");
  });

  it("forbids a non-member from viewing team detail and from inviting", async () => {
    const owner = await ensureUser("auth0|owner-5", "owner5@example.com");
    const stranger = await ensureUser("auth0|stranger-5", "stranger5@example.com");
    const teamId = await makeTeam(owner.userId, "epsilon");

    const detail = await bff("GET", `/bff/teams/${teamId}`, stranger.userId);
    expect(detail.statusCode).toBe(403);

    const invite = await bff("POST", `/bff/teams/${teamId}/invites`, stranger.userId, {
      email: "x@example.com",
      role: "member",
    });
    expect(invite.statusCode).toBe(403);
  });

  it("lets admin invite members but not remove other admins", async () => {
    const owner = await ensureUser("auth0|owner-6", "owner6@example.com");
    const admin = await ensureUser("auth0|admin-6", "admin6@example.com");
    const other = await ensureUser("auth0|admin-6b", "admin6b@example.com");
    const teamId = await makeTeam(owner.userId, "zeta");

    // owner 直接派两名 admin。
    await app.inject({ method: "POST", url: "/memberships/change-role", payload: { teamId, userId: admin.userId, role: "admin" } });
    await app.inject({ method: "POST", url: "/memberships/change-role", payload: { teamId, userId: other.userId, role: "admin" } });

    // admin 邀请 member：允许。
    const invited = await bff("POST", `/bff/teams/${teamId}/invites`, admin.userId, {
      email: "newmember6@example.com",
      role: "member",
    });
    expect(invited.statusCode).toBe(200);

    // admin 移除另一名 admin：拒绝。
    const removeAdmin = await bff("POST", `/bff/teams/${teamId}/members/remove`, admin.userId, {
      targetUserId: other.userId,
    });
    expect(removeAdmin.statusCode).toBe(403);
  });

  it("guards the last owner on both demotion and removal", async () => {
    const owner = await ensureUser("auth0|owner-7", "owner7@example.com");
    const teamId = await makeTeam(owner.userId, "eta");

    const demote = await bff("POST", `/bff/teams/${teamId}/members/change-role`, owner.userId, {
      targetUserId: owner.userId,
      role: "member",
    });
    expect(demote.statusCode).toBe(409);
    expect(demote.json().error.code).toBe("membership.last_owner");

    const remove = await bff("POST", `/bff/teams/${teamId}/members/remove`, owner.userId, {
      targetUserId: owner.userId,
    });
    expect(remove.statusCode).toBe(409);
    expect(remove.json().error.code).toBe("membership.last_owner");
  });

  it("removes a member so the hub check fails closed", async () => {
    const owner = await ensureUser("auth0|owner-8", "owner8@example.com");
    const member = await ensureUser("auth0|member-8", "member8@example.com");
    const teamId = await makeTeam(owner.userId, "theta");
    await app.inject({ method: "POST", url: "/memberships/change-role", payload: { teamId, userId: member.userId, role: "member" } });

    const removed = await bff("POST", `/bff/teams/${teamId}/members/remove`, owner.userId, {
      targetUserId: member.userId,
    });
    expect(removed.statusCode).toBe(200);

    const check = await app.inject({
      method: "GET",
      url: "/memberships/check",
      query: { teamId, userId: member.userId },
    });
    expect(check.json().data).toEqual({ active: false, role: null });
  });

  it("re-signs a runtime token for an active member and 403s a non-member", async () => {
    const owner = await ensureUser("auth0|owner-9", "owner9@example.com");
    const member = await ensureUser("auth0|member-9", "member9@example.com");
    const stranger = await ensureUser("auth0|stranger-9", "stranger9@example.com");
    const teamId = await makeTeam(owner.userId, "iota");
    await app.inject({ method: "POST", url: "/memberships/change-role", payload: { teamId, userId: member.userId, role: "member" } });

    const resign = await bff("POST", "/bff/auth/team-sessions", member.userId, { team_id: teamId });
    expect(resign.statusCode).toBe(200);
    expect(resign.json().data.namespace).toBe(teamId);
    expect(typeof resign.json().data.token).toBe("string");

    const forbidden = await bff("POST", "/bff/auth/team-sessions", stranger.userId, { team_id: teamId });
    expect(forbidden.statusCode).toBe(403);

    // 移除后换签立即 403（hub authorizer 沿用同一 active 语义）。
    await bff("POST", `/bff/teams/${teamId}/members/remove`, owner.userId, { targetUserId: member.userId });
    const afterRemoval = await bff("POST", "/bff/auth/team-sessions", member.userId, { team_id: teamId });
    expect(afterRemoval.statusCode).toBe(403);
  });

  it("lists my teams across personal and joined teams", async () => {
    const owner = await ensureUser("auth0|owner-10", "owner10@example.com");
    const invitee = await ensureUser("auth0|invitee-10", "invitee10@example.com");
    const teamId = await makeTeam(owner.userId, "kappa");
    const invited = await bff("POST", `/bff/teams/${teamId}/invites`, owner.userId, {
      email: "invitee10@example.com",
      role: "member",
    });
    await bff("POST", `/bff/invites/${invited.json().data.id}/accept`, invitee.userId);

    const teams = await bff("GET", "/bff/me/teams", invitee.userId);
    expect(teams.statusCode).toBe(200);
    const ids = teams.json().data.map((t: { team: { id: string } }) => t.team.id);
    expect(ids).toContain(teamId);
    expect(ids).toContain(invitee.personalTeamId);
  });
});
