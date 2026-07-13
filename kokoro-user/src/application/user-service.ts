import { TeamNotFoundError, UserNotFoundError } from "../domain/errors.js";
import type { Membership } from "../domain/membership.js";
import type {
  EnsureUserInput,
  EnsureUserResult,
  MemberTeamContext,
  MembershipCheckResult,
  OwnerActiveQuery,
  SetMembershipRoleInput,
  TeamSummary,
  UpsertTeamInput,
  UserRepository,
} from "../domain/repository.js";
import type { ServiceAccount } from "../domain/service-account.js";
import type { Team } from "../domain/team.js";
import { UserLifecycleError, type DeleteInput, type RestoreInput } from "../domain/user-deletion.js";
import type { User } from "../domain/user.js";

export class UserService {
  constructor(private readonly repository: UserRepository) {}

  async ensureUserWithPersonalTeam(input: EnsureUserInput): Promise<EnsureUserResult> {
    return this.repository.ensureUserWithPersonalTeam(input);
  }

  // 幂等：已 disabled 再调无害。用户不存在抛 UserNotFoundError。
  async disableUser(userId: string): Promise<User> {
    return this.requireUser(userId, await this.repository.setUserStatus(userId, "disabled"));
  }

  // 解禁是唯一能把 disabled 用户改回 active 的入口；登录 ensure 不会自动解禁。
  async enableUser(userId: string): Promise<User> {
    return this.requireUser(userId, await this.repository.setUserStatus(userId, "active"));
  }

  // 幂等建/更团队；(siteId,slug) 重复调用返回同一团队。
  async upsertTeam(input: UpsertTeamInput): Promise<Team> {
    return this.repository.upsertTeam(input);
  }

  // 给某 user 在某 team 派角色；team/user 不存在时抛对应 NotFound。
  async setMembershipRole(input: SetMembershipRoleInput): Promise<Membership> {
    const result = await this.repository.setMembershipRole(input);
    switch (result.outcome) {
      case "ok":
        return result.membership;
      case "team_not_found":
        throw new TeamNotFoundError(input.teamId);
      case "team_deleted":
        throw new UserLifecycleError("team.deleted", `team deleted: ${input.teamId}`, 409);
      case "team_disabled":
        throw new UserLifecycleError("team.disabled", `team disabled: ${input.teamId}`, 409);
      case "user_not_found":
        throw new UserNotFoundError(input.userId);
      case "user_deleted":
        throw new UserLifecycleError("user.deleted", `user deleted: ${input.userId}`, 409);
      case "user_disabled":
        throw new UserLifecycleError("user.disabled", `user disabled: ${input.userId}`, 409);
      case "cross_site":
        throw new UserLifecycleError("user.cross_site", "team and user belong to different sites", 409);
    }
  }

  async deleteUser(input: DeleteInput): Promise<User> {
    return this.repository.deleteUser(input);
  }

  async restoreUser(input: RestoreInput): Promise<User> {
    return this.repository.restoreUser(input);
  }

  async deleteTeam(input: DeleteInput): Promise<Team> {
    return this.repository.deleteTeam(input);
  }

  async restoreTeam(input: RestoreInput): Promise<Team> {
    return this.repository.restoreTeam(input);
  }

  async deleteServiceAccount(input: DeleteInput): Promise<ServiceAccount> {
    return this.repository.deleteServiceAccount(input);
  }

  async listTeamsForUser(userId: string): Promise<TeamSummary[]> {
    return this.repository.listTeamsForUser(userId);
  }

  // 下游记账前校验 owner 是否 active（封号/级联禁用即时生效）。
  async resolveOwnerActive(query: OwnerActiveQuery): Promise<boolean> {
    return this.repository.resolveOwnerActive(query);
  }

  // hub self 面授权：校验 (teamId,userId) 活跃成员关系与角色（读=member，写=owner/admin 由调用方判定）。
  async checkMembership(teamId: string, userId: string): Promise<MembershipCheckResult> {
    return this.repository.checkMembership(teamId, userId);
  }

  // 换签前置：校验活跃成员关系并回带签发所需 user/team；非活跃成员 → null。
  async resolveMemberTeamContext(userId: string, teamId: string): Promise<MemberTeamContext | null> {
    return this.repository.resolveMemberTeamContext(userId, teamId);
  }

  private requireUser(userId: string, user: User | null): User {
    if (!user) {
      throw new UserNotFoundError(userId);
    }
    return user;
  }
}
