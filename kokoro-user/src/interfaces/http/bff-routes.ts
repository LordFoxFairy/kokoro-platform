import { jsonSchema, sendData, sendError, sendZodError } from "@kokoro/platform-kit";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import type { SessionService } from "../../application/session-service.js";
import type { TeamService } from "../../application/team-service.js";
import { InvalidRuntimeNamespaceError, NotTeamMemberError } from "../../domain/session.js";
import {
  bffChangeRoleRequestSchema,
  bffRemoveMemberRequestSchema,
  createInviteRequestSchema,
  inviteIdParamsSchema,
  issueTeamSessionRequestSchema,
  teamIdParamsSchema,
} from "./schemas.js";

// 团队自助面（/bff/*）：web BFF 携 user principal（x-user-id header）调用。
// user principal 只活在 platform-user↔web BFF 之间；runtime 仍只见换签后的不透明 namespace。
export function registerBffRoutes(
  app: FastifyInstance,
  teamService: TeamService,
  sessionService: SessionService | null,
): void {
  app.get("/bff/me/teams", async (request, reply) => {
    const requestId = getRequestId(request);
    const userId = requireUserId(request, reply, requestId);
    if (userId === null) {
      return reply;
    }
    const teams = await teamService.listMyTeams(userId);
    return sendData(reply, teams, 200, requestId);
  });

  app.get("/bff/me/invites", async (request, reply) => {
    const requestId = getRequestId(request);
    const userId = requireUserId(request, reply, requestId);
    if (userId === null) {
      return reply;
    }
    const invites = await teamService.listMyInvites(userId);
    return sendData(reply, invites, 200, requestId);
  });

  app.get("/bff/teams/:teamId", async (request, reply) => {
    const requestId = getRequestId(request);
    const userId = requireUserId(request, reply, requestId);
    if (userId === null) {
      return reply;
    }
    const params = teamIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return sendZodError(reply, params.error, requestId);
    }
    const result = await teamService.getTeamDetail(params.data.teamId, userId);
    if (result.outcome === "not_member") {
      return sendError(reply, 403, "team.forbidden", "无权查看该团队", undefined, requestId);
    }
    return sendData(
      reply,
      {
        team: result.team,
        viewerRole: result.viewerRole,
        members: result.members,
        invites: result.invites,
      },
      200,
      requestId,
    );
  });

  app.post(
    "/bff/teams/:teamId/invites",
    { schema: { body: jsonSchema(createInviteRequestSchema) } },
    async (request, reply) => {
      const requestId = getRequestId(request);
      const userId = requireUserId(request, reply, requestId);
      if (userId === null) {
        return reply;
      }
      const params = teamIdParamsSchema.safeParse(request.params);
      if (!params.success) {
        return sendZodError(reply, params.error, requestId);
      }
      let body: ReturnType<typeof createInviteRequestSchema.parse>;
      try {
        body = createInviteRequestSchema.parse(request.body);
      } catch (error) {
        return handleZod(reply, error, requestId);
      }
      const result = await teamService.createInvite({
        teamId: params.data.teamId,
        actorUserId: userId,
        email: body.email,
        role: body.role,
      });
      switch (result.outcome) {
        case "ok":
          return sendData(reply, result.invite, 200, requestId);
        case "team_not_found":
          return sendError(reply, 404, "team.not_found", "团队不存在", undefined, requestId);
        case "not_authorized":
          return sendError(reply, 403, "team.forbidden", "无权邀请成员", undefined, requestId);
      }
    },
  );

  app.post("/bff/invites/:inviteId/accept", async (request, reply) => {
    const requestId = getRequestId(request);
    const userId = requireUserId(request, reply, requestId);
    if (userId === null) {
      return reply;
    }
    const params = inviteIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return sendZodError(reply, params.error, requestId);
    }
    const result = await teamService.acceptInvite(params.data.inviteId, userId);
    switch (result.outcome) {
      case "ok":
        return sendData(reply, { team: result.team, membership: result.membership }, 200, requestId);
      case "invite_not_found":
        return sendError(reply, 404, "invite.not_found", "邀请不存在", undefined, requestId);
      case "not_invitee":
        return sendError(reply, 403, "invite.forbidden", "邀请不属于当前用户", undefined, requestId);
      case "expired":
        return sendError(reply, 409, "invite.expired", "邀请已过期", undefined, requestId);
      case "not_pending":
        return sendError(reply, 409, "invite.not_pending", "邀请已失效", undefined, requestId);
      case "team_unavailable":
        return sendError(reply, 409, "invite.team_unavailable", "团队不可用", undefined, requestId);
    }
  });

  app.post("/bff/invites/:inviteId/decline", async (request, reply) => {
    const requestId = getRequestId(request);
    const userId = requireUserId(request, reply, requestId);
    if (userId === null) {
      return reply;
    }
    const params = inviteIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return sendZodError(reply, params.error, requestId);
    }
    const result = await teamService.declineInvite(params.data.inviteId, userId);
    switch (result.outcome) {
      case "ok":
        return sendData(reply, { ok: true }, 200, requestId);
      case "invite_not_found":
        return sendError(reply, 404, "invite.not_found", "邀请不存在", undefined, requestId);
      case "not_invitee":
        return sendError(reply, 403, "invite.forbidden", "邀请不属于当前用户", undefined, requestId);
      case "not_pending":
        return sendError(reply, 409, "invite.not_pending", "邀请已失效", undefined, requestId);
    }
  });

  app.post(
    "/bff/teams/:teamId/members/change-role",
    { schema: { body: jsonSchema(bffChangeRoleRequestSchema) } },
    async (request, reply) => {
      const requestId = getRequestId(request);
      const userId = requireUserId(request, reply, requestId);
      if (userId === null) {
        return reply;
      }
      const params = teamIdParamsSchema.safeParse(request.params);
      if (!params.success) {
        return sendZodError(reply, params.error, requestId);
      }
      let body: ReturnType<typeof bffChangeRoleRequestSchema.parse>;
      try {
        body = bffChangeRoleRequestSchema.parse(request.body);
      } catch (error) {
        return handleZod(reply, error, requestId);
      }
      const result = await teamService.changeMemberRole(
        params.data.teamId,
        userId,
        body.targetUserId,
        body.role,
      );
      switch (result.outcome) {
        case "ok":
          return sendData(reply, result.membership, 200, requestId);
        case "team_not_found":
          return sendError(reply, 404, "team.not_found", "团队不存在", undefined, requestId);
        case "not_authorized":
          return sendError(reply, 403, "team.forbidden", "无权修改成员角色", undefined, requestId);
        case "target_not_member":
          return sendError(reply, 404, "membership.not_member", "目标非团队成员", undefined, requestId);
        case "last_owner":
          return sendError(reply, 409, "membership.last_owner", "不能降级最后一个所有者", undefined, requestId);
      }
    },
  );

  app.post(
    "/bff/teams/:teamId/members/remove",
    { schema: { body: jsonSchema(bffRemoveMemberRequestSchema) } },
    async (request, reply) => {
      const requestId = getRequestId(request);
      const userId = requireUserId(request, reply, requestId);
      if (userId === null) {
        return reply;
      }
      const params = teamIdParamsSchema.safeParse(request.params);
      if (!params.success) {
        return sendZodError(reply, params.error, requestId);
      }
      let body: ReturnType<typeof bffRemoveMemberRequestSchema.parse>;
      try {
        body = bffRemoveMemberRequestSchema.parse(request.body);
      } catch (error) {
        return handleZod(reply, error, requestId);
      }
      const result = await teamService.removeMember(params.data.teamId, userId, body.targetUserId);
      switch (result.outcome) {
        case "ok":
          return sendData(reply, { ok: true }, 200, requestId);
        case "team_not_found":
          return sendError(reply, 404, "team.not_found", "团队不存在", undefined, requestId);
        case "not_authorized":
          return sendError(reply, 403, "team.forbidden", "无权移除该成员", undefined, requestId);
        case "target_not_member":
          return sendError(reply, 404, "membership.not_member", "目标非团队成员", undefined, requestId);
        case "last_owner":
          return sendError(reply, 409, "membership.last_owner", "不能移除最后一个所有者", undefined, requestId);
      }
    },
  );

  app.post(
    "/bff/auth/team-sessions",
    { schema: { body: jsonSchema(issueTeamSessionRequestSchema) } },
    async (request, reply) => {
      const requestId = getRequestId(request);
      const userId = requireUserId(request, reply, requestId);
      if (userId === null) {
        return reply;
      }
      // fail-closed：未配置签发密钥绝不签发。
      if (sessionService === null) {
        return sendError(reply, 503, "auth.not_configured", "会话签发未配置", undefined, requestId);
      }
      let body: ReturnType<typeof issueTeamSessionRequestSchema.parse>;
      try {
        body = issueTeamSessionRequestSchema.parse(request.body);
      } catch (error) {
        return handleZod(reply, error, requestId);
      }
      try {
        const issued = await sessionService.issueForTeam({ userId, teamId: body.team_id });
        return sendData(
          reply,
          {
            token: issued.token,
            namespace: issued.namespace,
            user: issued.user,
            team: issued.team,
            refresh_token: issued.refreshToken,
            refresh_expires_at: issued.refreshExpiresAt.toISOString(),
          },
          200,
          requestId,
        );
      } catch (error) {
        if (error instanceof NotTeamMemberError) {
          return sendError(reply, 403, "team.forbidden", "无权切换到该团队", undefined, requestId);
        }
        if (error instanceof InvalidRuntimeNamespaceError) {
          request.log.error("refusing to sign a non-opaque namespace");
          return sendError(reply, 500, "auth.invalid_namespace", "命名空间非法", undefined, requestId);
        }
        request.log.error({ error }, "failed to issue team session");
        return sendError(reply, 500, "auth.issue_failed", "会话签发失败", undefined, requestId);
      }
    },
  );
}

function handleZod(reply: FastifyReply, error: unknown, requestId: string) {
  if (error instanceof ZodError) {
    return sendZodError(reply, error, requestId);
  }
  throw error;
}

// user principal 由 web BFF 从密封信封解出后经 x-user-id header 注入；缺失即坏调用。
function requireUserId(request: FastifyRequest, reply: FastifyReply, requestId: string): string | null {
  const raw = request.headers["x-user-id"];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (!value) {
    sendError(reply, 400, "request.missing_user", "缺少 x-user-id", undefined, requestId);
    return null;
  }
  return value;
}

function getRequestId(request: FastifyRequest): string {
  const raw = request.headers["x-kokoro-request-id"] ?? request.headers["x-request-id"];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return value && value.length > 0 ? value : crypto.randomUUID();
}
