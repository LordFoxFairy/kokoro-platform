import { describe, expect, it } from "vitest";
import { UserService } from "../../src/application/user-service.js";
import { UserNotFoundError } from "../../src/domain/errors.js";
import type {
  EnsureUserInput,
  EnsureUserResult,
  TeamSummary,
  UserRepository,
} from "../../src/domain/repository.js";
import type { UserStatus } from "../../src/domain/user.js";

const now = new Date(0);

const ensureResult: EnsureUserResult = {
  user: {
    id: "u1",
    siteId: "site-1",
    externalUserId: "ext-1",
    email: "user@example.com",
    displayName: "User",
    avatarUrl: null,
    status: "active",
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
    createdAt: now,
    updatedAt: now,
  },
  membership: {
    id: "m1",
    teamId: "t1",
    userId: "u1",
    role: "owner",
    status: "active",
    createdAt: now,
    updatedAt: now,
  },
};

function trackingRepo(userExists = true): {
  repo: UserRepository;
  calls: Array<{ name: string; arg: unknown }>;
} {
  const calls: Array<{ name: string; arg: unknown }> = [];
  const repo: UserRepository = {
    ensureUserWithPersonalTeam: async (input: EnsureUserInput) => {
      calls.push({ name: "ensureUserWithPersonalTeam", arg: input });
      return ensureResult;
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
    listMemberships: async () => [ensureResult.membership],
    listServiceAccounts: async () => [],
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
});
