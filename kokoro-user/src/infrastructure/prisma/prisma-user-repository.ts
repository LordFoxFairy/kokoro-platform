import type { Prisma, PrismaClient } from "@prisma/client";
import type { Membership } from "../../domain/membership.js";
import type { ServiceAccount } from "../../domain/service-account.js";
import type { Team } from "../../domain/team.js";
import type { User, UserStatus } from "../../domain/user.js";
import type {
  EnsureUserInput,
  EnsureUserResult,
  TeamSummary,
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

  async setUserStatus(userId: string, status: UserStatus): Promise<User | null> {
    const existing = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!existing) {
      return null;
    }
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        status,
        disabledAt: status === "disabled" ? new Date() : null,
      },
    });
    return mapUser(updated);
  }

  async listTeamsForUser(userId: string): Promise<TeamSummary[]> {
    const memberships = await this.prisma.membership.findMany({
      where: {
        userId,
        status: "active",
        team: {
          status: "active",
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

  async listUsers(siteId?: string): Promise<User[]> {
    const users = await this.prisma.user.findMany({
      ...(siteId === undefined ? {} : { where: { siteId } }),
      take: ADMIN_LIST_TAKE,
      orderBy: { createdAt: "desc" },
    });
    return users.map(mapUser);
  }

  async listTeams(siteId?: string): Promise<Team[]> {
    const teams = await this.prisma.team.findMany({
      ...(siteId === undefined ? {} : { where: { siteId } }),
      take: ADMIN_LIST_TAKE,
      orderBy: { createdAt: "desc" },
    });
    return teams.map(mapTeam);
  }

  async listMemberships(): Promise<Membership[]> {
    const memberships = await this.prisma.membership.findMany({
      take: ADMIN_LIST_TAKE,
      orderBy: { createdAt: "desc" },
    });
    return memberships.map(mapMembership);
  }

  async listServiceAccounts(): Promise<ServiceAccount[]> {
    const accounts = await this.prisma.serviceAccount.findMany({
      take: ADMIN_LIST_TAKE,
      orderBy: { createdAt: "desc" },
    });
    return accounts.map(mapServiceAccount);
  }

  private async upsertUser(tx: TransactionClient, input: EnsureUserInput) {
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

    return tx.user.upsert({
      where: {
        siteId_externalUserId: {
          siteId: input.siteId,
          externalUserId: input.externalUserId,
        },
      },
      create: createInput,
      update: updateInput,
    });
  }

  private async upsertPersonalTeam(
    tx: TransactionClient,
    user: { id: string; siteId: string; displayName: string | null },
  ) {
    return tx.team.upsert({
      where: {
        personalOwnerUserId: user.id,
      },
      create: {
        siteId: user.siteId,
        name: user.displayName ? `${user.displayName}'s Personal Team` : "Personal Team",
        type: "personal",
        ownerUserId: user.id,
        personalOwnerUserId: user.id,
        status: "active",
      },
      update: {
        status: "active",
        disabledAt: null,
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
      },
    });
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

function mapUser(user: {
  id: string;
  siteId: string;
  externalUserId: string;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  status: "active" | "disabled";
  disabledAt: Date | null;
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
  createdAt: Date;
  updatedAt: Date;
}): Membership {
  return {
    id: membership.id,
    teamId: membership.teamId,
    userId: membership.userId,
    role: membership.role,
    status: membership.status,
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
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}
