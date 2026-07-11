import {
  jsonSchema,
  readRequestContext,
  registerAdminManifestRoute,
  registerHealthRoute,
  sendData,
  sendError,
  sendZodError,
} from "@kokoro/platform-kit";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import type { SkillHubService } from "../../application/skill-hub-service.js";
import { SkillRequiredError } from "../../domain/errors.js";
import { hubAdminManifest } from "../admin/manifest.js";
import {
  enableBodySchema,
  nameParamsSchema,
  namespaceQuerySchema,
  officialFlagsBodySchema,
  scopeNameParamsSchema,
} from "./schemas.js";

export function registerHubRoutes(app: FastifyInstance, service: SkillHubService): void {
  registerHealthRoute(app, "hub");
  registerAdminManifestRoute(app, hubAdminManifest);

  app.get(
    "/hub/skills/pool",
    { schema: { tags: ["hub"], summary: "查询某 namespace 的可用技能池" } },
    async (request, reply) => {
      const requestId = readRequestContext(request.headers).requestId;
      const query = namespaceQuerySchema.safeParse(request.query);
      if (!query.success) {
        return sendZodError(reply, query.error, requestId);
      }
      const skills = await service.listPool(query.data.namespace);
      return sendData(reply, { skills }, 200, requestId);
    },
  );

  app.get(
    "/hub/skills/quota",
    { schema: { tags: ["hub"], summary: "查询某 namespace 的上传配额视图" } },
    async (request, reply) => {
      const requestId = readRequestContext(request.headers).requestId;
      const query = namespaceQuerySchema.safeParse(request.query);
      if (!query.success) {
        return sendZodError(reply, query.error, requestId);
      }
      const quota = await service.quota(query.data.namespace);
      return sendData(reply, quota, 200, requestId);
    },
  );

  app.post(
    "/hub/skills/:scope/:name/enable",
    {
      schema: {
        tags: ["hub"],
        summary: "启用某技能（per-user 偏好）",
        body: jsonSchema(enableBodySchema),
      },
    },
    (request, reply) => toggleEnabled(service, request, reply, true),
  );

  app.post(
    "/hub/skills/:scope/:name/disable",
    {
      schema: {
        tags: ["hub"],
        summary: "停用某技能（per-user 偏好；required 官方技能拒关）",
        body: jsonSchema(enableBodySchema),
      },
    },
    (request, reply) => toggleEnabled(service, request, reply, false),
  );

  app.post(
    "/hub/skills/:name/official-flags",
    {
      schema: {
        tags: ["hub"],
        summary: "设置官方位（enabled 全局上架 / required 恒注入）",
        body: jsonSchema(officialFlagsBodySchema),
      },
    },
    async (request, reply) => {
      const requestId = readRequestContext(request.headers).requestId;
      try {
        const params = nameParamsSchema.parse(request.params);
        const flags = officialFlagsBodySchema.parse(request.body);
        await service.setOfficialFlags(params.name, flags);
        return sendData(reply, { ok: true }, 200, requestId);
      } catch (error) {
        if (error instanceof ZodError) {
          return sendZodError(reply, error, requestId);
        }
        request.log.error({ error }, "failed to set official flags");
        return sendError(reply, 500, "hub.official_flags_failed", "官方位更新失败", undefined, requestId);
      }
    },
  );

  app.delete(
    "/hub/skills/:scope/:name",
    { schema: { tags: ["hub"], summary: "软删某技能（置 deleted_at，包体永存）" } },
    async (request, reply) => {
      const requestId = readRequestContext(request.headers).requestId;
      try {
        const params = scopeNameParamsSchema.parse(request.params);
        await service.markDeleted(params.scope, params.name);
        return sendData(reply, { ok: true }, 200, requestId);
      } catch (error) {
        if (error instanceof ZodError) {
          return sendZodError(reply, error, requestId);
        }
        request.log.error({ error }, "failed to soft delete skill");
        return sendError(reply, 500, "hub.delete_failed", "技能删除失败", undefined, requestId);
      }
    },
  );
}

// 启停共用：scope 由路由携带但当前不参与 state 键（state = namespace+name，对齐 hub.py set_enabled）。
async function toggleEnabled(
  service: SkillHubService,
  request: FastifyRequest,
  reply: FastifyReply,
  enabled: boolean,
) {
  const requestId = readRequestContext(request.headers).requestId;
  try {
    const params = scopeNameParamsSchema.parse(request.params);
    const body = enableBodySchema.parse(request.body);
    await service.setEnabled(body.namespace, params.name, enabled);
    return sendData(reply, { ok: true }, 200, requestId);
  } catch (error) {
    if (error instanceof ZodError) {
      return sendZodError(reply, error, requestId);
    }
    if (error instanceof SkillRequiredError) {
      return sendError(reply, 409, "hub.skill_required", error.message, undefined, requestId);
    }
    request.log.error({ error }, "failed to toggle skill enabled");
    return sendError(reply, 500, "hub.toggle_failed", "技能启停失败", undefined, requestId);
  }
}
