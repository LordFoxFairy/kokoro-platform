import { createHash, randomBytes } from "node:crypto";
import type { MembershipRole } from "../domain/membership.js";
import type {
  AcceptInviteResult,
  ChangeMemberRoleResult,
  CreateInviteResult,
  DeclineInviteResult,
  PendingInviteView,
  RemoveMemberResult,
  TeamDetailResult,
  TeamSummary,
  UserRepository,
} from "../domain/repository.js";

export interface TeamServiceOptions {
  // 邀请存活时长；缺省 7 天。
  inviteTtlSeconds: number;
  now?: () => Date;
}

export interface CreateInviteCommand {
  teamId: string;
  actorUserId: string;
  email: string;
  role: Extract<MembershipRole, "admin" | "member">;
}

// 团队自助编排（web BFF 携 user principal 调用）：邀请/成员/换签授权都在此聚合。
// 授权判定沉在仓储事务（读 actor 成员关系与目标成员关系一致读），本层只做 token 生成与 TTL。
export class TeamService {
  private readonly now: () => Date;

  constructor(
    private readonly repository: UserRepository,
    private readonly options: TeamServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async listMyTeams(userId: string): Promise<TeamSummary[]> {
    return this.repository.listTeamsForUser(userId);
  }

  async listMyInvites(userId: string): Promise<PendingInviteView[]> {
    return this.repository.listPendingInvitesForUser(userId);
  }

  async createInvite(command: CreateInviteCommand): Promise<CreateInviteResult> {
    // token 原文只用于（未来）深链，落库仅存哈希；当前 V1 靠登录后 in-app 露出，不外发。
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
    const expiresAt = new Date(this.now().getTime() + this.options.inviteTtlSeconds * 1000);
    return this.repository.createInvite({
      teamId: command.teamId,
      actorUserId: command.actorUserId,
      email: command.email,
      role: command.role,
      tokenHash,
      expiresAt,
    });
  }

  async getTeamDetail(teamId: string, viewerUserId: string): Promise<TeamDetailResult> {
    return this.repository.getTeamDetailForViewer(teamId, viewerUserId);
  }

  async acceptInvite(inviteId: string, userId: string): Promise<AcceptInviteResult> {
    return this.repository.acceptInvite({ inviteId, userId });
  }

  async declineInvite(inviteId: string, userId: string): Promise<DeclineInviteResult> {
    return this.repository.declineInvite({ inviteId, userId });
  }

  async changeMemberRole(
    teamId: string,
    actorUserId: string,
    targetUserId: string,
    role: MembershipRole,
  ): Promise<ChangeMemberRoleResult> {
    return this.repository.changeMemberRole({ teamId, actorUserId, targetUserId, role });
  }

  async removeMember(
    teamId: string,
    actorUserId: string,
    targetUserId: string,
  ): Promise<RemoveMemberResult> {
    return this.repository.removeMember({ teamId, actorUserId, targetUserId });
  }
}
