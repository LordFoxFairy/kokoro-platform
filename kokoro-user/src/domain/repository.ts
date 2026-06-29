import type { Membership } from "./membership.js";
import type { ServiceAccount } from "./service-account.js";
import type { Team } from "./team.js";
import type { User } from "./user.js";

export interface EnsureUserInput {
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
  listTeamsForUser(userId: string): Promise<TeamSummary[]>;
  listUsers(): Promise<User[]>;
  listTeams(): Promise<Team[]>;
  listMemberships(): Promise<Membership[]>;
  listServiceAccounts(): Promise<ServiceAccount[]>;
}
