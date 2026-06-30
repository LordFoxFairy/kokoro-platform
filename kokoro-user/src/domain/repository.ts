import type { Membership } from "./membership.js";
import type { ServiceAccount } from "./service-account.js";
import type { Team } from "./team.js";
import type { User, UserStatus } from "./user.js";

export interface EnsureUserInput {
  siteId: string;
  externalUserId: string;
  email?: string | undefined;
  displayName?: string | undefined;
  avatarUrl?: string | undefined;
}

export interface EnsureUserResult {
  user: User;
  personalTeam: Team;
  membership: Membership;
}

export interface TeamSummary {
  team: Team;
  membership: Membership;
}

export interface UserRepository {
  ensureUserWithPersonalTeam(input: EnsureUserInput): Promise<EnsureUserResult>;
  // 管理员显式改 status；返回 null 表示用户不存在。disabled→disabledAt=now，active→disabledAt=null。
  setUserStatus(userId: string, status: UserStatus): Promise<User | null>;
  listTeamsForUser(userId: string): Promise<TeamSummary[]>;
  // 不传 siteId 保持全量（平台视图）；传则按站过滤（admin 工作台后续按站查）。
  listUsers(siteId?: string): Promise<User[]>;
  listTeams(siteId?: string): Promise<Team[]>;
  listMemberships(): Promise<Membership[]>;
  listServiceAccounts(): Promise<ServiceAccount[]>;
}
