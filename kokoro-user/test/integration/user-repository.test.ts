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
