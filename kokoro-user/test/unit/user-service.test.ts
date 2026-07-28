import { describe, expect, it } from "vitest";
import { UserService } from "../../src/application/user-service.js";
import { TeamNotFoundError, UserNotFoundError } from "../../src/domain/errors.js";
import type {
  EnsureUserInput,
  EnsureUserResult,
  SetMembershipRoleInput,
  SetMembershipRoleResult,
  TeamSummary,
  UpsertTeamInput,
  UserRepository,
} from "../../src/domain/repository.js";
import type { DeleteInput, RestoreInput } from "../../src/domain/user-deletion.js";
import type { UserStatus } from "../../src/domain/user.js";

const now = new Date(0);
const deletionAudit = {
  deletedAt: null,
  deletedBy: null,
  deleteReason: null,
};

const ensureResult: EnsureUserResult = {
  user: {
    id: "u1",
    siteId: "site-1",
    externalUserId: "ext-1",
    email: "user@example.com",
    displayName: "User",
    avatarUrl: null,
    status: "active",
    ...deletionAudit,
    createdAt: now,
    updatedAt: now,
  },
  personalTeam: {
    id: "t1",
    siteId: "site-1",
    name: "User's Personal Team",
    slug: null,
    type: "personal",
    ownerUserId: "u1",
    status: "active",
    ...deletionAudit,
    createdAt: now,
    updatedAt: now,
  },
  membership: {
    id: "m1",
    teamId: "t1",
    userId: "u1",
    role: "owner",
    status: "active",
    ...deletionAudit,
    createdAt: now,
    updatedAt: now,
  },
};

function trackingRepo(
  userExists = true,
  membershipOutcome: SetMembershipRoleResult["outcome"] = "ok",
): {
  repo: UserRepository;
  calls: Array<{ name: string; arg: unknown }>;
} {
  const calls: Array<{ name: string; arg: unknown }> = [];
  const repo: UserRepository = {
    ensureUserWithPersonalTeam: async (input: EnsureUserInput) => {
      calls.push({ name: "ensureUserWithPersonalTeam", arg: input });
      return ensureResult;
    },
    upsertTeam: async (input: UpsertTeamInput) => {
      calls.push({ name: "upsertTeam", arg: input });
      return { ...ensureResult.personalTeam, ...input, type: "team" };
    },
    setMembershipRole: async (input: SetMembershipRoleInput) => {
      calls.push({ name: "setMembershipRole", arg: input });
      if (membershipOutcome === "ok") {
        return { outcome: "ok", membership: { ...ensureResult.membership, ...input } };
      }
      return { outcome: membershipOutcome };
    },
    resolveOwnerActive: async () => userExists,
    checkMembership: async (teamId: string, userId: string) => {
      calls.push({ name: "checkMembership", arg: { teamId, userId } });
      return userExists ? { active: true, role: "owner" } : { active: false, role: null };
    },
    setUserStatus: async (userId: string, status: UserStatus) => {
      calls.push({ name: "setUserStatus", arg: { userId, status } });
      if (!userExists) {
        return null;
      }
      return {
        ...ensureResult.user,
        status,
        disabledAt: status === "disabled" ? now : null,
      };
    },
    deleteUser: async (input: DeleteInput) => {
      calls.push({ name: "deleteUser", arg: input });
      return { ...ensureResult.user, deletedAt: now, deletedBy: input.deletedBy, deleteReason: input.reason ?? null };
    },
    restoreUser: async (input: RestoreInput) => {
      calls.push({ name: "restoreUser", arg: input });
      return ensureResult.user;
    },
    deleteTeam: async (input: DeleteInput) => {
      calls.push({ name: "deleteTeam", arg: input });
      return { ...ensureResult.personalTeam, deletedAt: now, deletedBy: input.deletedBy, deleteReason: input.reason ?? null };
    },
    restoreTeam: async (input: RestoreInput) => {
      calls.push({ name: "restoreTeam", arg: input });
      return ensureResult.personalTeam;
    },
    deleteServiceAccount: async (input: DeleteInput) => {
      calls.push({ name: "deleteServiceAccount", arg: input });
      return {
        id: input.id,
        teamId: "t1",
        ownerUserId: null,
        name: "bot",
        tokenPrefix: "tok",
        status: "active",
        lastUsedAt: null,
        deletedAt: now,
        deletedBy: input.deletedBy,
        deleteReason: input.reason ?? null,
        createdAt: now,
        updatedAt: now,
      };
    },
    listTeamsForUser: async (userId: string) => {
      calls.push({ name: "listTeamsForUser", arg: userId });
      const summary: TeamSummary = {
        team: ensureResult.personalTeam,
        membership: ensureResult.membership,
      };
      return [summary];
    },
    listUsers: async () => [ensureResult.user],
    listTeams: async () => [ensureResult.personalTeam],
    listMemberships: async () => [{ ...ensureResult.membership, siteId: ensureResult.personalTeam.siteId }],
    listServiceAccounts: async () => [],
    createInvite: async () => ({ outcome: "team_not_found" }),
    getTeamDetailForViewer: async () => ({ outcome: "not_member" }),
    listPendingInvitesForUser: async () => [],
    acceptInvite: async () => ({ outcome: "invite_not_found" }),
    declineInvite: async () => ({ outcome: "invite_not_found" }),
    changeMemberRole: async () => ({ outcome: "team_not_found" }),
    removeMember: async () => ({ outcome: "team_not_found" }),
    resolveMemberTeamContext: async (userId: string, teamId: string) => {
      calls.push({ name: "resolveMemberTeamContext", arg: { userId, teamId } });
      return userExists
        ? { user: ensureResult.user, team: ensureResult.personalTeam, role: "owner" }
        : null;
    },
  };
  return { repo, calls };
}

describe("UserService delegation", () => {
  it("forwards ensureUserWithPersonalTeam input unchanged", async () => {
    const { repo, calls } = trackingRepo();
    const service = new UserService(repo);
    const input: EnsureUserInput = {
      siteId: "site-1",
      externalUserId: "ext-1",
      email: "user@example.com",
    };

    const result = await service.ensureUserWithPersonalTeam(input);

    expect(result).toBe(ensureResult);
    expect(calls).toEqual([{ name: "ensureUserWithPersonalTeam", arg: input }]);
  });

  it("forwards listTeamsForUser userId unchanged", async () => {
    const { repo, calls } = trackingRepo();
    const service = new UserService(repo);

    const teams = await service.listTeamsForUser("u1");

    expect(teams).toHaveLength(1);
    expect(teams[0]?.membership.role).toBe("owner");
    expect(calls).toEqual([{ name: "listTeamsForUser", arg: "u1" }]);
  });

  it("disableUser sets disabled status with disabledAt", async () => {
    const { repo, calls } = trackingRepo();
    const service = new UserService(repo);

    const user = await service.disableUser("u1");

    expect(user.status).toBe("disabled");
    expect(user.disabledAt).toEqual(now);
    expect(calls).toEqual([{ name: "setUserStatus", arg: { userId: "u1", status: "disabled" } }]);
  });

  it("enableUser sets active status and clears disabledAt", async () => {
    const { repo, calls } = trackingRepo();
    const service = new UserService(repo);

    const user = await service.enableUser("u1");

    expect(user.status).toBe("active");
    expect(user.disabledAt).toBeNull();
    expect(calls).toEqual([{ name: "setUserStatus", arg: { userId: "u1", status: "active" } }]);
  });

  it("throws UserNotFoundError when the user does not exist", async () => {
    const { repo } = trackingRepo(false);
    const service = new UserService(repo);

    await expect(service.disableUser("missing")).rejects.toThrow(UserNotFoundError);
    await expect(service.enableUser("missing")).rejects.toThrow(UserNotFoundError);
  });

  it("forwards upsertTeam input unchanged", async () => {
    const { repo, calls } = trackingRepo();
    const service = new UserService(repo);
    const input: UpsertTeamInput = {
      siteId: "site-1",
      slug: "acme",
      name: "Acme",
      ownerUserId: "u1",
    };

    const team = await service.upsertTeam(input);

    expect(team.slug).toBe("acme");
    expect(team.type).toBe("team");
    expect(calls).toEqual([{ name: "upsertTeam", arg: input }]);
  });

  it("setMembershipRole returns the membership on ok", async () => {
    const { repo, calls } = trackingRepo();
    const service = new UserService(repo);
    const input: SetMembershipRoleInput = { teamId: "t1", userId: "u1", role: "admin" };

    const membership = await service.setMembershipRole(input);

    expect(membership.role).toBe("admin");
    expect(calls).toEqual([{ name: "setMembershipRole", arg: input }]);
  });

  it("setMembershipRole translates team_not_found and user_not_found", async () => {
    const teamMissing = new UserService(trackingRepo(true, "team_not_found").repo);
    await expect(
      teamMissing.setMembershipRole({ teamId: "t1", userId: "u1", role: "admin" }),
    ).rejects.toThrow(TeamNotFoundError);

    const userMissing = new UserService(trackingRepo(true, "user_not_found").repo);
    await expect(
      userMissing.setMembershipRole({ teamId: "t1", userId: "u1", role: "admin" }),
    ).rejects.toThrow(UserNotFoundError);
  });

  it("setMembershipRole translates lifecycle outcomes into stable codes", async () => {
    const cases: Array<[SetMembershipRoleResult["outcome"], string]> = [
      ["team_deleted", "team.deleted"],
      ["team_disabled", "team.disabled"],
      ["user_deleted", "user.deleted"],
      ["user_disabled", "user.disabled"],
      ["cross_site", "user.cross_site"],
    ];

    for (const [outcome, code] of cases) {
      const service = new UserService(trackingRepo(true, outcome).repo);
      await expect(
        service.setMembershipRole({ teamId: "t1", userId: "u1", role: "admin" }),
      ).rejects.toMatchObject({ code });
    }
  });

  it("delegates lifecycle delete and restore methods", async () => {
    const { repo, calls } = trackingRepo();
    const service = new UserService(repo);

    await service.deleteUser({ id: "u1", deletedBy: "operator", reason: "closed" });
    await service.restoreUser({ id: "u1" });
    await service.deleteTeam({ id: "t1", deletedBy: "operator" });
    await service.restoreTeam({ id: "t1" });
    await service.deleteServiceAccount({ id: "sa1", deletedBy: "operator" });

    expect(calls).toEqual([
      { name: "deleteUser", arg: { id: "u1", deletedBy: "operator", reason: "closed" } },
      { name: "restoreUser", arg: { id: "u1" } },
      { name: "deleteTeam", arg: { id: "t1", deletedBy: "operator" } },
      { name: "restoreTeam", arg: { id: "t1" } },
      { name: "deleteServiceAccount", arg: { id: "sa1", deletedBy: "operator" } },
    ]);
  });
});
