import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaUserRepository } from "../../src/infrastructure/prisma/prisma-user-repository.js";
import { cleanUserDatabase, createTestPrismaClient } from "./helpers.js";

const prisma = createTestPrismaClient();
const repository = new PrismaUserRepository(prisma);

describe("PrismaUserRepository", () => {
  beforeEach(async () => {
    await cleanUserDatabase(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("creates a user, personal team, and owner membership", async () => {
    const result = await repository.ensureUserWithPersonalTeam({
      siteId: "site-a",
      externalUserId: "auth0|repo-user",
      email: "repo@example.com",
      displayName: "Repo User",
    });

    expect(result.user.siteId).toBe("site-a");
    expect(result.user.externalUserId).toBe("auth0|repo-user");
    expect(result.personalTeam.siteId).toBe("site-a");
    expect(result.personalTeam.type).toBe("personal");
    expect(result.personalTeam.ownerUserId).toBe(result.user.id);
    expect(result.membership.role).toBe("owner");
    expect(result.membership.teamId).toBe(result.personalTeam.id);
    expect(result.membership.userId).toBe(result.user.id);
  });

  it("cascades disable/enable from the user to its personal team", async () => {
    const { user, personalTeam } = await repository.ensureUserWithPersonalTeam({
      siteId: "site-a",
      externalUserId: "auth0|disable-cascade",
      email: "cascade@example.com",
      displayName: "Cascade",
    });

    const disabled = await repository.setUserStatus(user.id, "disabled");
    expect(disabled?.status).toBe("disabled");
    const afterDisable = await prisma.team.findUnique({ where: { id: personalTeam.id } });
    expect(afterDisable?.status).toBe("disabled");
    expect(afterDisable?.disabledAt).not.toBeNull();

    const enabled = await repository.setUserStatus(user.id, "active");
    expect(enabled?.status).toBe("active");
    const afterEnable = await prisma.team.findUnique({ where: { id: personalTeam.id } });
    expect(afterEnable?.status).toBe("active");
    expect(afterEnable?.disabledAt).toBeNull();
  });

  it("resolves owner active for user/team and false for disabled, cross-site, or missing", async () => {
    const { user, personalTeam } = await repository.ensureUserWithPersonalTeam({
      siteId: "site-a",
      externalUserId: "auth0|owner-active",
      email: "owner@example.com",
      displayName: "Owner",
    });

    expect(await repository.resolveOwnerActive({ siteId: "site-a", ownerKind: "user", ownerId: user.id })).toBe(true);
    expect(await repository.resolveOwnerActive({ siteId: "site-a", ownerKind: "team", ownerId: personalTeam.id })).toBe(true);
    // 跨站不认
    expect(await repository.resolveOwnerActive({ siteId: "site-b", ownerKind: "user", ownerId: user.id })).toBe(false);
    // 不存在
    expect(await repository.resolveOwnerActive({ siteId: "site-a", ownerKind: "user", ownerId: "missing" })).toBe(false);
    // 禁用后（含级联的 personal team）一并为 false
    await repository.setUserStatus(user.id, "disabled");
    expect(await repository.resolveOwnerActive({ siteId: "site-a", ownerKind: "user", ownerId: user.id })).toBe(false);
    expect(await repository.resolveOwnerActive({ siteId: "site-a", ownerKind: "team", ownerId: personalTeam.id })).toBe(false);
  });

  it("deletes and restores a user from owner checks and default lists", async () => {
    const { user, personalTeam } = await repository.ensureUserWithPersonalTeam({
      siteId: "site-a",
      externalUserId: "auth0|delete-user",
      email: "delete-user@example.com",
      displayName: "Delete User",
    });

    const deleted = await repository.deleteUser({
      id: user.id,
      deletedBy: "operator-1",
      reason: "identity closed",
    });

    expect(deleted.id).toBe(user.id);
    expect(deleted.deletedAt).toBeInstanceOf(Date);
    expect(deleted.deletedBy).toBe("operator-1");
    expect(deleted.deleteReason).toBe("identity closed");
    expect(await repository.resolveOwnerActive({ siteId: "site-a", ownerKind: "user", ownerId: user.id })).toBe(false);
    expect(await repository.resolveOwnerActive({ siteId: "site-a", ownerKind: "team", ownerId: personalTeam.id })).toBe(false);
    expect(await repository.listUsers("site-a")).toEqual([]);

    const withDeleted = await repository.listUsers("site-a", { includeDeleted: true });
    expect(withDeleted).toHaveLength(1);
    expect(withDeleted[0]?.id).toBe(user.id);

    await expect(
      repository.ensureUserWithPersonalTeam({
        siteId: "site-a",
        externalUserId: "auth0|delete-user",
        displayName: "Recreated User",
      }),
    ).rejects.toMatchObject({ code: "user.deleted" });

    const restored = await repository.restoreUser({ id: user.id });
    expect(restored.deletedAt).toBeNull();
    expect(restored.deletedBy).toBeNull();
    expect(restored.deleteReason).toBeNull();
    expect(await repository.resolveOwnerActive({ siteId: "site-a", ownerKind: "user", ownerId: user.id })).toBe(true);
    expect(await repository.resolveOwnerActive({ siteId: "site-a", ownerKind: "team", ownerId: personalTeam.id })).toBe(true);
  });

  it("deletes and restores a team from owner checks and membership reads", async () => {
    const { user } = await repository.ensureUserWithPersonalTeam({
      siteId: "site-a",
      externalUserId: "auth0|team-owner",
      displayName: "Team Owner",
    });
    const team = await repository.upsertTeam({
      siteId: "site-a",
      slug: "ops",
      name: "Ops",
      ownerUserId: user.id,
    });
    await prisma.serviceAccount.create({
      data: {
        teamId: team.id,
        name: "deploy",
        tokenPrefix: "tok_delete_team",
        secretHash: "secret",
        status: "active",
      },
    });

    const deleted = await repository.deleteTeam({ id: team.id, deletedBy: "operator-1", reason: "team retired" });

    expect(deleted.id).toBe(team.id);
    expect(deleted.deletedAt).toBeInstanceOf(Date);
    expect(await repository.resolveOwnerActive({ siteId: "site-a", ownerKind: "team", ownerId: team.id })).toBe(false);
    expect(await repository.listTeams("site-a")).not.toContainEqual(expect.objectContaining({ id: team.id }));
    expect(await repository.listServiceAccounts()).toEqual([]);

    const restored = await repository.restoreTeam({ id: team.id });
    expect(restored.deletedAt).toBeNull();
    expect(await repository.resolveOwnerActive({ siteId: "site-a", ownerKind: "team", ownerId: team.id })).toBe(true);
  });

  it("rejects team and membership writes against deleted or cross-site owners", async () => {
    const owner = await repository.ensureUserWithPersonalTeam({
      siteId: "site-a",
      externalUserId: "auth0|owner-a",
      displayName: "Owner A",
    });
    const member = await repository.ensureUserWithPersonalTeam({
      siteId: "site-a",
      externalUserId: "auth0|member-a",
      displayName: "Member A",
    });
    const otherSiteOwner = await repository.ensureUserWithPersonalTeam({
      siteId: "site-b",
      externalUserId: "auth0|owner-b",
      displayName: "Owner B",
    });

    await expect(
      repository.upsertTeam({
        siteId: "site-a",
        slug: "cross",
        name: "Cross",
        ownerUserId: otherSiteOwner.user.id,
      }),
    ).rejects.toMatchObject({ code: "user.cross_site" });

    await repository.deleteUser({ id: owner.user.id, deletedBy: "operator-1", reason: "owner closed" });
    await expect(
      repository.upsertTeam({
        siteId: "site-a",
        slug: "deleted-owner",
        name: "Deleted Owner",
        ownerUserId: owner.user.id,
      }),
    ).rejects.toMatchObject({ code: "user.deleted" });

    const team = await repository.upsertTeam({
      siteId: "site-a",
      slug: "members",
      name: "Members",
      ownerUserId: member.user.id,
    });
    await repository.deleteTeam({ id: team.id, deletedBy: "operator-1", reason: "team closed" });
    const changed = await repository.setMembershipRole({
      teamId: team.id,
      userId: member.user.id,
      role: "admin",
    });
    expect(changed).toEqual({ outcome: "team_deleted" });
  });

  it("is idempotent for the same external user", async () => {
    const first = await repository.ensureUserWithPersonalTeam({
      siteId: "site-a",
      externalUserId: "auth0|stable-user",
      displayName: "Stable User",
    });

    const second = await repository.ensureUserWithPersonalTeam({
      siteId: "site-a",
      externalUserId: "auth0|stable-user",
      email: "stable@example.com",
      displayName: "Stable User Updated",
    });

    expect(second.user.id).toBe(first.user.id);
    expect(second.personalTeam.id).toBe(first.personalTeam.id);
    expect(second.membership.id).toBe(first.membership.id);
    expect(second.user.email).toBe("stable@example.com");

    const personalTeams = await prisma.team.findMany({
      where: {
        personalOwnerUserId: first.user.id,
      },
    });
    expect(personalTeams).toHaveLength(1);
  });

  it("lists active teams for a user", async () => {
    const result = await repository.ensureUserWithPersonalTeam({
      siteId: "site-a",
      externalUserId: "auth0|teams-user",
      displayName: "Teams User",
    });

    const teams = await repository.listTeamsForUser(result.user.id);

    expect(teams).toHaveLength(1);
    expect(teams[0]?.team.id).toBe(result.personalTeam.id);
    expect(teams[0]?.membership.role).toBe("owner");
  });

  // 同一 externalUserId 跨两站隔离：复合唯一键保证生成两个独立 User。
  it("isolates the same external user across sites", async () => {
    const onA = await repository.ensureUserWithPersonalTeam({
      siteId: "site-a",
      externalUserId: "auth0|shared",
      displayName: "Shared",
    });
    const onB = await repository.ensureUserWithPersonalTeam({
      siteId: "site-b",
      externalUserId: "auth0|shared",
      displayName: "Shared",
    });

    expect(onA.user.id).not.toBe(onB.user.id);
    expect(onA.user.siteId).toBe("site-a");
    expect(onB.user.siteId).toBe("site-b");

    const siteAUsers = await repository.listUsers("site-a");
    expect(siteAUsers).toHaveLength(1);
    expect(siteAUsers[0]?.id).toBe(onA.user.id);

    const allUsers = await repository.listUsers();
    expect(allUsers).toHaveLength(2);
  });
});
