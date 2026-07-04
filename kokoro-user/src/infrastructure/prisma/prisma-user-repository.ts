import type { Prisma, PrismaClient } from "@prisma/client";
import type { Membership } from "../../domain/membership.js";
import type { ServiceAccount } from "../../domain/service-account.js";
import type { Team } from "../../domain/team.js";
import {
  UserLifecycleError,
  type DeleteInput,
  type ListOptions,
  type RestoreInput,
} from "../../domain/user-deletion.js";
import type { User, UserStatus } from "../../domain/user.js";
import type {
  EnsureUserInput,
  EnsureUserResult,
  OwnerActiveQuery,
  SetMembershipRoleInput,
  SetMembershipRoleResult,
  TeamSummary,
  UpsertTeamInput,
  UserRepository,
} from "../../domain/repository.js";

// WHY: admin 只读列表上限，避免全表扫描拖垮后台。
const ADMIN_LIST_TAKE = 100;

type TransactionClient = Prisma.TransactionClient;

export class PrismaUserRepository implements UserRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async ensureUserWithPersonalTeam(input: EnsureUserInput): Promise<EnsureUserResult> {
    return this.prisma.$transaction(async (tx) => {
      const user = await this.upsertUser(tx, input);
      const team = await this.upsertPersonalTeam(tx, user);
      const membership = await this.upsertOwnerMembership(tx, user.id, team.id);

      return {
        user: mapUser(user),
        personalTeam: mapTeam(team),
        membership: mapMembership(membership),
      };
    });
  }

  async upsertTeam(input: UpsertTeamInput): Promise<Team> {
    return this.prisma.$transaction(async (tx) => {
      await this.requireWritableOwnerUser(tx, input.siteId, input.ownerUserId);

      const existing = await tx.team.findUnique({
        where: { siteId_slug: { siteId: input.siteId, slug: input.slug } },
      });
      if (existing?.deletedAt) {
        throw lifecycleError("team.deleted", `team deleted: ${existing.id}`, 409);
      }

      // 幂等键 (siteId,slug)：重复调用刷新 name/owner，不新建；type 固定 team(个人团队走 ensure)。
      const team = existing
        ? await tx.team.update({
            where: { id: existing.id },
            data: {
              name: input.name,
              ownerUserId: input.ownerUserId,
              status: "active",
              disabledAt: null,
            },
          })
        : await tx.team.create({
            data: {
              siteId: input.siteId,
              slug: input.slug,
              name: input.name,
              type: "team",
              ownerUserId: input.ownerUserId,
              status: "active",
            },
          });
      await this.upsertOwnerMembership(tx, input.ownerUserId, team.id);
      return mapTeam(team);
    });
  }

  async setMembershipRole(input: SetMembershipRoleInput): Promise<SetMembershipRoleResult> {
    const [team, user] = await Promise.all([
      this.prisma.team.findUnique({ where: { id: input.teamId } }),
      this.prisma.user.findUnique({ where: { id: input.userId } }),
    ]);
    if (!team) {
      return { outcome: "team_not_found" };
    }
    if (team.deletedAt) {
      return { outcome: "team_deleted" };
    }
    if (team.status !== "active") {
      return { outcome: "team_disabled" };
    }
    if (!user) {
      return { outcome: "user_not_found" };
    }
    if (user.deletedAt) {
      return { outcome: "user_deleted" };
    }
    if (user.status !== "active") {
      return { outcome: "user_disabled" };
    }
    if (team.siteId !== user.siteId) {
      return { outcome: "cross_site" };
    }

    const membership = await this.prisma.membership.upsert({
      where: { teamId_userId: { teamId: input.teamId, userId: input.userId } },
      create: {
        teamId: input.teamId,
        userId: input.userId,
        role: input.role,
        status: "active",
      },
      update: {
        role: input.role,
        status: "active",
        disabledAt: null,
        ...restoreData(),
      },
    });
    return { outcome: "ok", membership: mapMembership(membership) };
  }

  async setUserStatus(userId: string, status: UserStatus): Promise<User | null> {
    const existing = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!existing) {
      return null;
    }
    const disabledAt = status === "disabled" ? new Date() : null;
    // 级联个人团队：personal team 是该用户作为计费 owner 的实体，不同步则下游按 team 计费会绕过禁用。
    const [updated] = await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { status, disabledAt },
      }),
      this.prisma.team.updateMany({
        where: { personalOwnerUserId: userId },
        data: { status: status === "disabled" ? "disabled" : "active", disabledAt },
      }),
    ]);
    return mapUser(updated);
  }

  async deleteUser(input: DeleteInput): Promise<User> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({ where: { id: input.id } });
      if (!existing) {
        throw lifecycleError("user.not_found", `user not found: ${input.id}`, 404);
      }
      if (existing.deletedAt) {
        return mapUser(existing);
      }

      const data = deletionData(input);
      const personalTeamIds = await this.findPersonalTeamIds(tx, input.id);
      const deleted = await tx.user.update({
        where: { id: input.id },
        data,
      });

      await tx.team.updateMany({
        where: { personalOwnerUserId: input.id, deletedAt: null },
        data,
      });
      await tx.membership.updateMany({
        where: {
          deletedAt: null,
          OR: [{ userId: input.id }, { teamId: { in: personalTeamIds } }],
        },
        data,
      });
      await tx.serviceAccount.updateMany({
        where: {
          deletedAt: null,
          OR: [{ ownerUserId: input.id }, { teamId: { in: personalTeamIds } }],
        },
        data,
      });

      return mapUser(deleted);
    });
  }

  async restoreUser(input: RestoreInput): Promise<User> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({ where: { id: input.id } });
      if (!existing) {
        throw lifecycleError("user.not_found", `user not found: ${input.id}`, 404);
      }
      if (!existing.deletedAt) {
        return mapUser(existing);
      }

      const data = restoreData();
      const personalTeamIds = await this.findPersonalTeamIds(tx, input.id);
      const restored = await tx.user.update({
        where: { id: input.id },
        data,
      });

      await tx.team.updateMany({
        where: { personalOwnerUserId: input.id },
        data,
      });
      await tx.membership.updateMany({
        where: {
          OR: [{ userId: input.id }, { teamId: { in: personalTeamIds } }],
        },
        data,
      });
      await tx.serviceAccount.updateMany({
        where: {
          OR: [{ ownerUserId: input.id }, { teamId: { in: personalTeamIds } }],
        },
        data,
      });

      return mapUser(restored);
    });
  }

  async deleteTeam(input: DeleteInput): Promise<Team> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.team.findUnique({ where: { id: input.id } });
      if (!existing) {
        throw lifecycleError("team.not_found", `team not found: ${input.id}`, 404);
      }
      if (existing.deletedAt) {
        return mapTeam(existing);
      }

      const data = deletionData(input);
      const deleted = await tx.team.update({
        where: { id: input.id },
        data,
      });
      await this.updateTeamSubresources(tx, input.id, data, true);
      return mapTeam(deleted);
    });
  }

  async restoreTeam(input: RestoreInput): Promise<Team> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.team.findUnique({ where: { id: input.id } });
      if (!existing) {
        throw lifecycleError("team.not_found", `team not found: ${input.id}`, 404);
      }
      if (!existing.deletedAt) {
        return mapTeam(existing);
      }

      const data = restoreData();
      const restored = await tx.team.update({
        where: { id: input.id },
        data,
      });
      await this.updateTeamSubresources(tx, input.id, data, false);
      return mapTeam(restored);
    });
  }

  async deleteServiceAccount(input: DeleteInput): Promise<ServiceAccount> {
    const existing = await this.prisma.serviceAccount.findUnique({ where: { id: input.id } });
    if (!existing) {
      throw lifecycleError("service_account.not_found", `service account not found: ${input.id}`, 404);
    }
    if (existing.deletedAt) {
      return mapServiceAccount(existing);
    }
    const deleted = await this.prisma.serviceAccount.update({
      where: { id: input.id },
      data: deletionData(input),
    });
    return mapServiceAccount(deleted);
  }

  async resolveOwnerActive(query: OwnerActiveQuery): Promise<boolean> {
    if (query.ownerKind === "user") {
      const user = await this.prisma.user.findUnique({ where: { id: query.ownerId } });
      return user !== null && user.siteId === query.siteId && user.status === "active" && user.deletedAt === null;
    }
    const team = await this.prisma.team.findUnique({ where: { id: query.ownerId } });
    return team !== null && team.siteId === query.siteId && team.status === "active" && team.deletedAt === null;
  }

  async listTeamsForUser(userId: string): Promise<TeamSummary[]> {
    const memberships = await this.prisma.membership.findMany({
      where: {
        userId,
        status: "active",
        deletedAt: null,
        team: {
          status: "active",
          deletedAt: null,
        },
      },
      include: {
        team: true,
      },
      orderBy: {
        createdAt: "asc",
      },
    });

    return memberships.map((membership) => ({
      team: mapTeam(membership.team),
      membership: mapMembership(membership),
    }));
  }

  async listUsers(siteId?: string, options?: ListOptions): Promise<User[]> {
    const where: Prisma.UserWhereInput = {
      ...(siteId === undefined ? {} : { siteId }),
      ...visibleRows(options),
    };
    const users = await this.prisma.user.findMany({
      where,
      take: ADMIN_LIST_TAKE,
      orderBy: { createdAt: "desc" },
    });
    return users.map(mapUser);
  }

  async listTeams(siteId?: string, options?: ListOptions): Promise<Team[]> {
    const where: Prisma.TeamWhereInput = {
      ...(siteId === undefined ? {} : { siteId }),
      ...visibleRows(options),
    };
    const teams = await this.prisma.team.findMany({
      where,
      take: ADMIN_LIST_TAKE,
      orderBy: { createdAt: "desc" },
    });
    return teams.map(mapTeam);
  }

  async listMemberships(options?: ListOptions): Promise<Membership[]> {
    const memberships = await this.prisma.membership.findMany({
      where: visibleRows(options),
      take: ADMIN_LIST_TAKE,
      orderBy: { createdAt: "desc" },
    });
    return memberships.map(mapMembership);
  }

  async listServiceAccounts(options?: ListOptions): Promise<ServiceAccount[]> {
    const accounts = await this.prisma.serviceAccount.findMany({
      where: visibleRows(options),
      take: ADMIN_LIST_TAKE,
      orderBy: { createdAt: "desc" },
    });
    return accounts.map(mapServiceAccount);
  }

  private async upsertUser(tx: TransactionClient, input: EnsureUserInput) {
    const existing = await tx.user.findUnique({
      where: {
        siteId_externalUserId: {
          siteId: input.siteId,
          externalUserId: input.externalUserId,
        },
      },
    });
    if (existing?.deletedAt) {
      throw lifecycleError("user.deleted", `user deleted: ${existing.id}`, 409);
    }

    const createInput: Prisma.UserCreateInput = {
      siteId: input.siteId,
      externalUserId: input.externalUserId,
      ...definedString("email", input.email),
      ...definedString("displayName", input.displayName),
      ...definedString("avatarUrl", input.avatarUrl),
    };

    // WHY: ensure 只刷新资料，不重置 status/disabledAt——否则被管理员 disable 的用户一登录就被自动解禁。
    const updateInput: Prisma.UserUpdateInput = {
      ...definedString("email", input.email),
      ...definedString("displayName", input.displayName),
      ...definedString("avatarUrl", input.avatarUrl),
    };

    if (existing) {
      return tx.user.update({
        where: { id: existing.id },
        data: updateInput,
      });
    }

    return tx.user.create({ data: createInput });
  }

  private async upsertPersonalTeam(
    tx: TransactionClient,
    user: { id: string; siteId: string; displayName: string | null },
  ) {
    const existing = await tx.team.findUnique({
      where: {
        personalOwnerUserId: user.id,
      },
    });
    if (existing?.deletedAt) {
      throw lifecycleError("team.deleted", `personal team deleted: ${existing.id}`, 409);
    }

    if (existing) {
      return tx.team.update({
        where: { id: existing.id },
        data: {
          status: "active",
          disabledAt: null,
        },
      });
    }

    return tx.team.create({
      data: {
        siteId: user.siteId,
        name: user.displayName ? `${user.displayName}'s Personal Team` : "Personal Team",
        type: "personal",
        ownerUserId: user.id,
        personalOwnerUserId: user.id,
        status: "active",
      },
    });
  }

  private async upsertOwnerMembership(tx: TransactionClient, userId: string, teamId: string) {
    return tx.membership.upsert({
      where: {
        teamId_userId: {
          teamId,
          userId,
        },
      },
      create: {
        teamId,
        userId,
        role: "owner",
        status: "active",
      },
      update: {
        role: "owner",
        status: "active",
        disabledAt: null,
        ...restoreData(),
      },
    });
  }

  private async requireWritableOwnerUser(tx: TransactionClient, siteId: string, userId: string) {
    const owner = await tx.user.findUnique({ where: { id: userId } });
    if (!owner) {
      throw lifecycleError("user.not_found", `owner user not found: ${userId}`, 404);
    }
    if (owner.siteId !== siteId) {
      throw lifecycleError("user.cross_site", `owner user belongs to another site: ${userId}`, 409);
    }
    if (owner.deletedAt) {
      throw lifecycleError("user.deleted", `owner user deleted: ${userId}`, 409);
    }
    if (owner.status !== "active") {
      throw lifecycleError("user.disabled", `owner user disabled: ${userId}`, 409);
    }
    return owner;
  }

  private async findPersonalTeamIds(tx: TransactionClient, userId: string): Promise<string[]> {
    const teams = await tx.team.findMany({
      where: { personalOwnerUserId: userId },
      select: { id: true },
    });
    return teams.map((team) => team.id);
  }

  private async updateTeamSubresources(
    tx: TransactionClient,
    teamId: string,
    data: ReturnType<typeof deletionData> | ReturnType<typeof restoreData>,
    onlyVisibleRows: boolean,
  ): Promise<void> {
    const where = onlyVisibleRows ? { teamId, deletedAt: null } : { teamId };
    await Promise.all([
      tx.membership.updateMany({ where, data }),
      tx.serviceAccount.updateMany({ where, data }),
      tx.role.updateMany({ where, data }),
      tx.invite.updateMany({ where, data }),
    ]);
  }
}

function definedString<Key extends "email" | "displayName" | "avatarUrl">(
  key: Key,
  value: string | undefined,
): Partial<Record<Key, string>> {
  if (value === undefined) {
    return {};
  }
  const out: Partial<Record<Key, string>> = {};
  out[key] = value;
  return out;
}

function visibleRows(options: ListOptions | undefined): { deletedAt: null } | Record<string, never> {
  return options?.includeDeleted === true ? {} : { deletedAt: null };
}

function deletionData(input: DeleteInput): {
  deletedAt: Date;
  deletedBy: string;
  deleteReason: string | null;
} {
  return {
    deletedAt: new Date(),
    deletedBy: input.deletedBy,
    deleteReason: input.reason ?? null,
  };
}

function restoreData(): {
  deletedAt: null;
  deletedBy: null;
  deleteReason: null;
} {
  return {
    deletedAt: null,
    deletedBy: null,
    deleteReason: null,
  };
}

function lifecycleError(code: ConstructorParameters<typeof UserLifecycleError>[0], message: string, statusCode: number) {
  return new UserLifecycleError(code, message, statusCode);
}

function mapUser(user: {
  id: string;
  siteId: string;
  externalUserId: string;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  status: "active" | "disabled";
  disabledAt: Date | null;
  deletedAt: Date | null;
  deletedBy: string | null;
  deleteReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}): User {
  return {
    id: user.id,
    siteId: user.siteId,
    externalUserId: user.externalUserId,
    email: user.email,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    status: user.status,
    disabledAt: user.disabledAt,
    deletedAt: user.deletedAt,
    deletedBy: user.deletedBy,
    deleteReason: user.deleteReason,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function mapTeam(team: {
  id: string;
  siteId: string;
  name: string;
  slug: string | null;
  type: "personal" | "team";
  ownerUserId: string;
  status: "active" | "disabled";
  deletedAt: Date | null;
  deletedBy: string | null;
  deleteReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}): Team {
  return {
    id: team.id,
    siteId: team.siteId,
    name: team.name,
    slug: team.slug,
    type: team.type,
    ownerUserId: team.ownerUserId,
    status: team.status,
    deletedAt: team.deletedAt,
    deletedBy: team.deletedBy,
    deleteReason: team.deleteReason,
    createdAt: team.createdAt,
    updatedAt: team.updatedAt,
  };
}

function mapMembership(membership: {
  id: string;
  teamId: string;
  userId: string;
  role: "owner" | "admin" | "member";
  status: "active" | "disabled";
  deletedAt: Date | null;
  deletedBy: string | null;
  deleteReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}): Membership {
  return {
    id: membership.id,
    teamId: membership.teamId,
    userId: membership.userId,
    role: membership.role,
    status: membership.status,
    deletedAt: membership.deletedAt,
    deletedBy: membership.deletedBy,
    deleteReason: membership.deleteReason,
    createdAt: membership.createdAt,
    updatedAt: membership.updatedAt,
  };
}

function mapServiceAccount(account: {
  id: string;
  teamId: string | null;
  ownerUserId: string | null;
  name: string;
  tokenPrefix: string;
  status: "active" | "disabled";
  lastUsedAt: Date | null;
  deletedAt: Date | null;
  deletedBy: string | null;
  deleteReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}): ServiceAccount {
  return {
    id: account.id,
    teamId: account.teamId,
    ownerUserId: account.ownerUserId,
    name: account.name,
    tokenPrefix: account.tokenPrefix,
    status: account.status,
    lastUsedAt: account.lastUsedAt,
    deletedAt: account.deletedAt,
    deletedBy: account.deletedBy,
    deleteReason: account.deleteReason,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}
