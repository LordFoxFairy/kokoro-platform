import type { Invite, InviteStatus } from "./invite.js";
import type { Membership, MembershipRole, MembershipStatus } from "./membership.js";
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

// ── 团队自助面（web BFF 携 user principal 调用）：邀请/成员/换签。─────────────────────

// 邀请落库入参：actor 必须是该 team 的活跃 owner/admin；role 限 admin/member（不可邀 owner）。
export interface CreateInviteInput {
  teamId: string;
  actorUserId: string;
  email: string;
  role: Extract<MembershipRole, "admin" | "member">;
  tokenHash: string;
  expiresAt: Date;
}

export type CreateInviteResult =
  | { outcome: "ok"; invite: Invite }
  | { outcome: "team_not_found" }
  | { outcome: "not_authorized" };

// 成员管理页视图行：成员含用户资料，pending 邀请单列。
export interface TeamMemberView {
  userId: string;
  email: string | null;
  displayName: string | null;
  role: MembershipRole;
  status: MembershipStatus;
  joinedAt: Date;
}

export interface TeamInviteView {
  id: string;
  email: string;
  role: MembershipRole;
  status: InviteStatus;
  expiresAt: Date;
  createdAt: Date;
}

export type TeamDetailResult =
  | {
      outcome: "ok";
      team: Team;
      viewerRole: MembershipRole;
      members: TeamMemberView[];
      // 仅 owner/admin 可见 pending 邀请；member 视图为空数组。
      invites: TeamInviteView[];
    }
  | { outcome: "not_member" };

// 被邀者登录后可见的 pending 邀请（按解析出的本人 email 匹配）。
export interface PendingInviteView {
  id: string;
  teamId: string;
  teamName: string;
  role: MembershipRole;
  expiresAt: Date;
  createdAt: Date;
}

export interface AcceptInviteInput {
  inviteId: string;
  userId: string;
}

export type AcceptInviteResult =
  | { outcome: "ok"; membership: Membership; team: Team }
  | { outcome: "invite_not_found" }
  | { outcome: "not_invitee" }
  | { outcome: "expired" }
  | { outcome: "not_pending" }
  | { outcome: "team_unavailable" };

export interface DeclineInviteInput {
  inviteId: string;
  userId: string;
}

export type DeclineInviteResult =
  | { outcome: "ok" }
  | { outcome: "invite_not_found" }
  | { outcome: "not_invitee" }
  | { outcome: "not_pending" };

// 改角色：仅 owner；不能把唯一 owner 降级。
export interface ChangeMemberRoleInput {
  teamId: string;
  actorUserId: string;
  targetUserId: string;
  role: MembershipRole;
}

export type ChangeMemberRoleResult =
  | { outcome: "ok"; membership: Membership }
  | { outcome: "team_not_found" }
  | { outcome: "not_authorized" }
  | { outcome: "target_not_member" }
  | { outcome: "last_owner" };

// 移除成员：owner 可移除任何人（唯一 owner 除外）；admin 只能移除 member。
export interface RemoveMemberInput {
  teamId: string;
  actorUserId: string;
  targetUserId: string;
}

export type RemoveMemberResult =
  | { outcome: "ok" }
  | { outcome: "team_not_found" }
  | { outcome: "not_authorized" }
  | { outcome: "target_not_member" }
  | { outcome: "last_owner" };

// 换签前置：校验 (userId,teamId) 活跃成员关系，并回带签发所需的 user/team。null=非活跃成员。
export interface MemberTeamContext {
  user: User;
  team: Team;
  role: MembershipRole;
}

export interface UserRepository {
  ensureUserWithPersonalTeam(input: EnsureUserInput): Promise<EnsureUserResult>;
  createInvite(input: CreateInviteInput): Promise<CreateInviteResult>;
  getTeamDetailForViewer(teamId: string, viewerUserId: string): Promise<TeamDetailResult>;
  listPendingInvitesForUser(userId: string): Promise<PendingInviteView[]>;
  acceptInvite(input: AcceptInviteInput): Promise<AcceptInviteResult>;
  declineInvite(input: DeclineInviteInput): Promise<DeclineInviteResult>;
  changeMemberRole(input: ChangeMemberRoleInput): Promise<ChangeMemberRoleResult>;
  removeMember(input: RemoveMemberInput): Promise<RemoveMemberResult>;
  resolveMemberTeamContext(userId: string, teamId: string): Promise<MemberTeamContext | null>;
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
