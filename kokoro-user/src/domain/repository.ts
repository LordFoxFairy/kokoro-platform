import type { Membership, MembershipRole } from "./membership.js";
import type { ServiceAccount } from "./service-account.js";
import type { Team } from "./team.js";
import type { DeleteInput, ListOptions, RestoreInput } from "./user-deletion.js";
import type { User, UserStatus } from "./user.js";

// hub self 面授权用窄口结果：active=该 user 是所属 team 的活跃成员（team 也活跃）；role=其角色或 null。
export interface MembershipCheckResult {
  active: boolean;
  role: MembershipRole | null;
}

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

export type OwnerKind = "user" | "team";

export interface OwnerActiveQuery {
  siteId: string;
  ownerKind: OwnerKind;
  ownerId: string;
}

export interface UpsertTeamInput {
  siteId: string;
  slug: string;
  name: string;
  ownerUserId: string;
}

export interface SetMembershipRoleInput {
  teamId: string;
  userId: string;
  role: MembershipRole;
}

export type SetMembershipRoleResult =
  | { outcome: "ok"; membership: Membership }
  | { outcome: "team_not_found" }
  | { outcome: "team_deleted" }
  | { outcome: "team_disabled" }
  | { outcome: "user_not_found" }
  | { outcome: "user_deleted" }
  | { outcome: "user_disabled" }
  | { outcome: "cross_site" };

export interface UserRepository {
  ensureUserWithPersonalTeam(input: EnsureUserInput): Promise<EnsureUserResult>;
  // 幂等建/更团队(非个人团队)：以 (siteId,slug) 为键 upsert，并保证 owner 拥有 owner 成员关系。
  upsertTeam(input: UpsertTeamInput): Promise<Team>;
  // 设某 user 在某 team 的角色：以 (teamId,userId) upsert 成员关系；team/user 不存在时不写入。
  setMembershipRole(input: SetMembershipRoleInput): Promise<SetMembershipRoleResult>;
  // 下游记账前校验：(siteId,ownerKind,ownerId) 对应实体是否 active；不存在/跨站/禁用均返回 false。
  resolveOwnerActive(query: OwnerActiveQuery): Promise<boolean>;
  // hub self 面授权窄口：(teamId,userId) 是否活跃成员及角色；无成员关系/team 非活跃均 fail-closed 为 inactive。
  checkMembership(teamId: string, userId: string): Promise<MembershipCheckResult>;
  // 管理员显式改 status；返回 null 表示用户不存在。disabled→disabledAt=now，active→disabledAt=null。
  setUserStatus(userId: string, status: UserStatus): Promise<User | null>;
  deleteUser(input: DeleteInput): Promise<User>;
  restoreUser(input: RestoreInput): Promise<User>;
  deleteTeam(input: DeleteInput): Promise<Team>;
  restoreTeam(input: RestoreInput): Promise<Team>;
  deleteServiceAccount(input: DeleteInput): Promise<ServiceAccount>;
  listTeamsForUser(userId: string): Promise<TeamSummary[]>;
  // 不传 siteId 保持全量（平台视图）；传则按站过滤（admin 工作台后续按站查）。
  listUsers(siteId?: string, options?: ListOptions): Promise<User[]>;
  listTeams(siteId?: string, options?: ListOptions): Promise<Team[]>;
  listMemberships(options?: ListOptions): Promise<Membership[]>;
  listServiceAccounts(options?: ListOptions): Promise<ServiceAccount[]>;
}
