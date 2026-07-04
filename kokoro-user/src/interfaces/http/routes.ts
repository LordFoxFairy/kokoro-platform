import {
  jsonSchema,
  readRequestContext,
  registerHealthRoute,
  sendData,
  sendError,
  sendZodError,
} from "@kokoro/platform-kit";
import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { UserService } from "../../application/user-service.js";
import { TeamNotFoundError, UserNotFoundError } from "../../domain/errors.js";
import { isUserLifecycleError } from "../../domain/user-deletion.js";
import {
  deleteRequestSchema,
  ensureUserRequestSchema,
  ownerActiveParamsSchema,
  serviceAccountParamsSchema,
  setMembershipRoleRequestSchema,
  teamParamsSchema,
  upsertTeamRequestSchema,
  userParamsSchema,
} from "./schemas.js";

export function registerUserRoutes(app: FastifyInstance, service: UserService): void {
  registerHealthRoute(app, "user");

  app.post(
    "/users/ensure",
    {
      schema: {
        tags: ["user"],
        summary: "确保用户存在并附带个人团队",
        body: jsonSchema(ensureUserRequestSchema),
      },
    },
    async (request, reply) => {
      const requestId = getRequestId(request.headers["x-request-id"]);

      // siteId 是上下文（来自 header），不是业务载荷，不进 body schema。
      const ctx = readRequestContext(request.headers);
      if (ctx.siteId === null) {
        return sendError(reply, 400, "context.site_required", "缺少站点上下文", undefined, requestId);
      }

      try {
        const input = ensureUserRequestSchema.parse(request.body);
        const result = await service.ensureUserWithPersonalTeam({ ...input, siteId: ctx.siteId });
        return sendData(reply, result, 200, requestId);
      } catch (error) {
        if (error instanceof ZodError) {
          return sendZodError(reply, error, requestId);
        }
        const lifecycle = sendLifecycleError(reply, error, requestId);
        if (lifecycle) {
          return lifecycle;
        }

        request.log.error({ error }, "failed to ensure user");
        return sendError(reply, 500, "user.ensure_failed", "用户创建或更新失败", undefined, requestId);
      }
    },
  );

  app.delete(
    "/users/:userId",
    {
      schema: {
        tags: ["user"],
        summary: "删除用户",
        body: jsonSchema(deleteRequestSchema),
      },
    },
    async (request, reply) => {
      const requestId = getRequestId(request.headers["x-request-id"]);
      try {
        const params = userParamsSchema.parse(request.params);
        const body = deleteRequestSchema.parse(request.body);
        const user = await service.deleteUser({
          id: params.userId,
          deletedBy: body.deletedBy,
          reason: body.reason,
        });
        return sendData(reply, user, 200, requestId);
      } catch (error) {
        if (error instanceof ZodError) {
          return sendZodError(reply, error, requestId);
        }
        const lifecycle = sendLifecycleError(reply, error, requestId);
        if (lifecycle) {
          return lifecycle;
        }
        request.log.error({ error }, "failed to delete user");
        return sendError(reply, 500, "user.delete_failed", "用户删除失败", undefined, requestId);
      }
    },
  );

  app.post(
    "/users/:userId/restore",
    { schema: { tags: ["user"], summary: "恢复用户" } },
    async (request, reply) => {
      const requestId = getRequestId(request.headers["x-request-id"]);
      try {
        const params = userParamsSchema.parse(request.params);
        const user = await service.restoreUser({ id: params.userId });
        return sendData(reply, user, 200, requestId);
      } catch (error) {
        if (error instanceof ZodError) {
          return sendZodError(reply, error, requestId);
        }
        const lifecycle = sendLifecycleError(reply, error, requestId);
        if (lifecycle) {
          return lifecycle;
        }
        request.log.error({ error }, "failed to restore user");
        return sendError(reply, 500, "user.restore_failed", "用户恢复失败", undefined, requestId);
      }
    },
  );

  // 下游(credit/payment)记账前调用：校验 (siteId, ownerKind, ownerId) 是否 active。
  app.get(
    "/owners/:ownerKind/:ownerId/active",
    { schema: { tags: ["user"], summary: "校验 owner 是否 active" } },
    async (request, reply) => {
      const requestId = getRequestId(request.headers["x-request-id"]);
      const ctx = readRequestContext(request.headers);
      if (ctx.siteId === null) {
        return sendError(reply, 400, "context.site_required", "缺少站点上下文", undefined, requestId);
      }
      const params = ownerActiveParamsSchema.safeParse(request.params);
      if (!params.success) {
        return sendZodError(reply, params.error, requestId);
      }
      const active = await service.resolveOwnerActive({
        siteId: ctx.siteId,
        ownerKind: params.data.ownerKind,
        ownerId: params.data.ownerId,
      });
      return sendData(reply, { active }, 200, requestId);
    },
  );

  app.get(
    "/me/teams",
    { schema: { tags: ["user"], summary: "列出当前用户所属团队" } },
    async (request, reply) => {
      const requestId = getRequestId(request.headers["x-request-id"]);
      const userId = getSingleHeader(request.headers["x-user-id"]);

      if (!userId) {
        return sendError(reply, 400, "request.missing_user", "缺少 x-user-id", undefined, requestId);
      }

      try {
        const teams = await service.listTeamsForUser(userId);
        return sendData(reply, teams, 200, requestId);
      } catch (error) {
        request.log.error({ error }, "failed to list user teams");
        return sendError(reply, 500, "team.list_failed", "团队列表获取失败", undefined, requestId);
      }
    },
  );

  app.post(
    "/teams/upsert",
    {
      schema: {
        tags: ["user"],
        summary: "创建或更新团队(幂等 by siteId+slug)",
        body: jsonSchema(upsertTeamRequestSchema),
      },
    },
    async (request, reply) => {
      const requestId = getRequestId(request.headers["x-request-id"]);
      const ctx = readRequestContext(request.headers);
      if (ctx.siteId === null) {
        return sendError(reply, 400, "context.site_required", "缺少站点上下文", undefined, requestId);
      }
      try {
        const input = upsertTeamRequestSchema.parse(request.body);
        const team = await service.upsertTeam({ ...input, siteId: ctx.siteId });
        return sendData(reply, team, 200, requestId);
      } catch (error) {
        if (error instanceof ZodError) {
          return sendZodError(reply, error, requestId);
        }
        const lifecycle = sendLifecycleError(reply, error, requestId);
        if (lifecycle) {
          return lifecycle;
        }
        request.log.error({ error }, "failed to upsert team");
        return sendError(reply, 500, "team.upsert_failed", "团队保存失败", undefined, requestId);
      }
    },
  );

  app.delete(
    "/teams/:teamId",
    {
      schema: {
        tags: ["user"],
        summary: "删除团队",
        body: jsonSchema(deleteRequestSchema),
      },
    },
    async (request, reply) => {
      const requestId = getRequestId(request.headers["x-request-id"]);
      try {
        const params = teamParamsSchema.parse(request.params);
        const body = deleteRequestSchema.parse(request.body);
        const team = await service.deleteTeam({
          id: params.teamId,
          deletedBy: body.deletedBy,
          reason: body.reason,
        });
        return sendData(reply, team, 200, requestId);
      } catch (error) {
        if (error instanceof ZodError) {
          return sendZodError(reply, error, requestId);
        }
        const lifecycle = sendLifecycleError(reply, error, requestId);
        if (lifecycle) {
          return lifecycle;
        }
        request.log.error({ error }, "failed to delete team");
        return sendError(reply, 500, "team.delete_failed", "团队删除失败", undefined, requestId);
      }
    },
  );

  app.post(
    "/teams/:teamId/restore",
    { schema: { tags: ["user"], summary: "恢复团队" } },
    async (request, reply) => {
      const requestId = getRequestId(request.headers["x-request-id"]);
      try {
        const params = teamParamsSchema.parse(request.params);
        const team = await service.restoreTeam({ id: params.teamId });
        return sendData(reply, team, 200, requestId);
      } catch (error) {
        if (error instanceof ZodError) {
          return sendZodError(reply, error, requestId);
        }
        const lifecycle = sendLifecycleError(reply, error, requestId);
        if (lifecycle) {
          return lifecycle;
        }
        request.log.error({ error }, "failed to restore team");
        return sendError(reply, 500, "team.restore_failed", "团队恢复失败", undefined, requestId);
      }
    },
  );

  app.delete(
    "/service-accounts/:serviceAccountId",
    {
      schema: {
        tags: ["user"],
        summary: "删除服务账号",
        body: jsonSchema(deleteRequestSchema),
      },
    },
    async (request, reply) => {
      const requestId = getRequestId(request.headers["x-request-id"]);
      try {
        const params = serviceAccountParamsSchema.parse(request.params);
        const body = deleteRequestSchema.parse(request.body);
        const account = await service.deleteServiceAccount({
          id: params.serviceAccountId,
          deletedBy: body.deletedBy,
          reason: body.reason,
        });
        return sendData(reply, account, 200, requestId);
      } catch (error) {
        if (error instanceof ZodError) {
          return sendZodError(reply, error, requestId);
        }
        const lifecycle = sendLifecycleError(reply, error, requestId);
        if (lifecycle) {
          return lifecycle;
        }
        request.log.error({ error }, "failed to delete service account");
        return sendError(
          reply,
          500,
          "service_account.delete_failed",
          "服务账号删除失败",
          undefined,
          requestId,
        );
      }
    },
  );

  app.post(
    "/memberships/change-role",
    {
      schema: {
        tags: ["user"],
        summary: "设置某 user 在某 team 的角色",
        body: jsonSchema(setMembershipRoleRequestSchema),
      },
    },
    async (request, reply) => {
      const requestId = getRequestId(request.headers["x-request-id"]);
      try {
        const input = setMembershipRoleRequestSchema.parse(request.body);
        const membership = await service.setMembershipRole(input);
        return sendData(reply, membership, 200, requestId);
      } catch (error) {
        if (error instanceof ZodError) {
          return sendZodError(reply, error, requestId);
        }
        if (error instanceof TeamNotFoundError) {
          return sendError(reply, 404, "team.not_found", "团队不存在", undefined, requestId);
        }
        if (error instanceof UserNotFoundError) {
          return sendError(reply, 404, "user.not_found", "用户不存在", undefined, requestId);
        }
        const lifecycle = sendLifecycleError(reply, error, requestId);
        if (lifecycle) {
          return lifecycle;
        }
        request.log.error({ error }, "failed to change membership role");
        return sendError(
          reply,
          500,
          "membership.change_role_failed",
          "成员角色更新失败",
          undefined,
          requestId,
        );
      }
    },
  );
}

function sendLifecycleError(
  reply: Parameters<typeof sendError>[0],
  error: unknown,
  requestId: string,
) {
  if (!isUserLifecycleError(error)) {
    return null;
  }
  return sendError(reply, error.statusCode, error.code, error.message, undefined, requestId);
}

function getRequestId(value: string | string[] | undefined): string {
  return getSingleHeader(value) ?? crypto.randomUUID();
}

function getSingleHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return normalizeHeaderValue(value[0]);
  }

  return normalizeHeaderValue(value);
}

function normalizeHeaderValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
