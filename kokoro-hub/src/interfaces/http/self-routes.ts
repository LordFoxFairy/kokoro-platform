// self 面路由（HUB-AUTHZ）：仅 web-bff caller。scope 恒取自密封信封头 x-kokoro-namespace
// （路由不收 scope/namespace 参数，收到即 400 伪造）；userId 取自 x-kokoro-user-id 头。
// 每请求先经 user 服务校验 active membership：读=member，写=owner/admin。
// MCP 只读；一切 MCP mutation 恒 503 capability_registration_disabled（fail-closed，待 HUB-CONSIST 才开）。
//
// 信任边界注记：本面信任 x-kokoro-namespace / x-kokoro-user-id 两头仅在 web-bff caller 面注入
// （由 route-access 的 web-bff 等级保证只有 web-bff 凭据可达此前缀；信封机制在 AUTH-P0）。

import {
  readRequestContext,
  sendData,
  sendError,
  sendZodError,
} from "@kokoro/platform-kit";
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import type { McpHubService } from "../../application/mcp-hub-service.js";
import type { SkillHubService } from "../../application/skill-hub-service.js";
import type { SkillUploadService } from "../../application/skill-upload-service.js";
import { SkillRequiredError } from "../../domain/errors.js";
import type { MembershipAuthorizer } from "./membership-authorizer.js";
import { nameParamsSchema } from "./schemas.js";
import { readSelfUploadPayload, replyUploadError, UPLOAD_BODY_LIMIT } from "./upload-routes.js";

const NAMESPACE_HEADER = "x-kokoro-namespace";
const USER_ID_HEADER = "x-kokoro-user-id";
// MCP 注册 fail-closed 门的稳定错误码（BFF/UI 据此显示“能力注册暂未开放”，而非当作 404）。
const CAPABILITY_DISABLED_CODE = "capability_registration_disabled";

export interface SelfRouteServices {
  skillService: SkillHubService;
  uploadService: SkillUploadService;
  // 缺省 null = 无 MCP 仓储：MCP 只读面返回空池（mutation 仍恒 503）。
  mcpService: McpHubService | null;
  authorizer: MembershipAuthorizer;
}

function headerValue(request: FastifyRequest, key: string): string | undefined {
  const raw = request.headers[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

// self 面禁止在 query 携带 scope/namespace（scope 恒取信封头）；命中即 scope 伪造。
function hasScopeQuery(request: FastifyRequest): boolean {
  const query = request.query;
  if (query === null || typeof query !== "object") {
    return false;
  }
  return (
    Object.prototype.hasOwnProperty.call(query, "namespace") ||
    Object.prototype.hasOwnProperty.call(query, "scope")
  );
}

// guard 通过后 scope 头必在；防御性再取一次，缺失即 bug（交全局 handler 报 500）。
function selfScope(request: FastifyRequest): string {
  const scope = headerValue(request, NAMESPACE_HEADER);
  if (scope === undefined) {
    throw new Error("self namespace header missing after membership guard");
  }
  return scope;
}

// 成员校验前置钩子：scope 伪造 400 → 缺信封头 400 → 非成员 403 → 写面非 owner/admin 403。
function membershipGuard(authorizer: MembershipAuthorizer, mode: "read" | "write"): preHandlerHookHandler {
  return async (request, reply) => {
    const requestId = readRequestContext(request.headers).requestId;
    if (hasScopeQuery(request)) {
      return sendError(
        reply,
        400,
        "hub.self_scope_forbidden",
        "self 面 scope 恒取自信封头，拒收 scope/namespace 参数",
        undefined,
        requestId,
      );
    }
    const scope = headerValue(request, NAMESPACE_HEADER);
    if (scope === undefined) {
      return sendError(reply, 400, "context.namespace_required", "缺少 x-kokoro-namespace 信封头", undefined, requestId);
    }
    const userId = headerValue(request, USER_ID_HEADER);
    if (userId === undefined) {
      return sendError(reply, 400, "context.user_required", "缺少 x-kokoro-user-id 信封头", undefined, requestId);
    }
    const check = await authorizer.check(readRequestContext(request.headers), scope, userId);
    if (!check.active) {
      return sendError(reply, 403, "hub.forbidden_not_member", "非该 namespace 的活跃成员", undefined, requestId);
    }
    if (mode === "write" && check.role !== "owner" && check.role !== "admin") {
      return sendError(reply, 403, "hub.forbidden_not_writer", "成员无写权限（需 owner/admin）", undefined, requestId);
    }
  };
}

function capabilityDisabled(reply: FastifyReply, requestId: string): FastifyReply {
  return sendError(
    reply,
    503,
    CAPABILITY_DISABLED_CODE,
    "MCP 能力注册暂未开放（fail-closed，待 HUB-CONSIST 跨仓一致后开启）",
    undefined,
    requestId,
  );
}

export function registerSelfRoutes(app: FastifyInstance, services: SelfRouteServices): void {
  const { skillService, uploadService, mcpService, authorizer } = services;
  const readGuard = membershipGuard(authorizer, "read");
  const writeGuard = membershipGuard(authorizer, "write");

  // ---- skills 只读（member）----
  app.get(
    "/hub/self/skills/pool",
    { preHandler: readGuard, schema: { tags: ["hub-self"], summary: "查询本 namespace 可用技能池（scope=信封头）" } },
    async (request, reply) => {
      const requestId = readRequestContext(request.headers).requestId;
      const skills = await skillService.listPool(selfScope(request));
      return sendData(reply, { skills }, 200, requestId);
    },
  );

  app.get(
    "/hub/self/skills/quota",
    { preHandler: readGuard, schema: { tags: ["hub-self"], summary: "查询本 namespace 上传配额视图（scope=信封头）" } },
    async (request, reply) => {
      const requestId = readRequestContext(request.headers).requestId;
      const quota = await skillService.quota(selfScope(request));
      return sendData(reply, quota, 200, requestId);
    },
  );

  app.get(
    "/hub/self/skills/:name/revisions",
    { preHandler: readGuard, schema: { tags: ["hub-self"], summary: "本 namespace 某技能版本历史（scope=信封头）" } },
    async (request, reply) => {
      const requestId = readRequestContext(request.headers).requestId;
      const params = nameParamsSchema.safeParse(request.params);
      if (!params.success) {
        return sendZodError(reply, params.error, requestId);
      }
      const revisions = await uploadService.revisions(selfScope(request), params.data.name);
      return sendData(reply, { revisions }, 200, requestId);
    },
  );

  // ---- skills 写（owner/admin）----
  app.post(
    "/hub/self/skills/:name/enable",
    { preHandler: writeGuard, schema: { tags: ["hub-self"], summary: "启用本 namespace 某技能（per-user 偏好）" } },
    (request, reply) => selfToggle(skillService, request, reply, true),
  );

  app.post(
    "/hub/self/skills/:name/disable",
    { preHandler: writeGuard, schema: { tags: ["hub-self"], summary: "停用本 namespace 某技能（required 官方技能拒关）" } },
    (request, reply) => selfToggle(skillService, request, reply, false),
  );

  app.post(
    "/hub/self/skills/upload/preview",
    {
      preHandler: writeGuard,
      bodyLimit: UPLOAD_BODY_LIMIT,
      schema: { tags: ["hub-self"], summary: "上传预检（scope=信封头）：解包校验不落库" },
    },
    async (request, reply) => {
      const requestId = readRequestContext(request.headers).requestId;
      try {
        const payload = await readSelfUploadPayload(request);
        const preview = await uploadService.preview(selfScope(request), payload.zip);
        return sendData(reply, preview, 200, requestId);
      } catch (error) {
        const handled = replyUploadError(reply, error, requestId);
        if (handled !== null) {
          return handled;
        }
        request.log.error({ error }, "failed to preview self skill upload");
        return sendError(reply, 500, "hub.upload_preview_failed", "上传预检失败", undefined, requestId);
      }
    },
  );

  app.post(
    "/hub/self/skills/upload/confirm",
    {
      preHandler: writeGuard,
      bodyLimit: UPLOAD_BODY_LIMIT,
      schema: { tags: ["hub-self"], summary: "上传发布（scope=信封头）：内容寻址包体 + upsert" },
    },
    async (request, reply) => {
      const requestId = readRequestContext(request.headers).requestId;
      try {
        const payload = await readSelfUploadPayload(request);
        const scope = selfScope(request);
        const results = await uploadService.confirm(scope, payload.zip, payload.names);
        return sendData(reply, { namespace: scope, results }, 200, requestId);
      } catch (error) {
        const handled = replyUploadError(reply, error, requestId);
        if (handled !== null) {
          return handled;
        }
        request.log.error({ error }, "failed to confirm self skill upload");
        return sendError(reply, 500, "hub.upload_confirm_failed", "上传发布失败", undefined, requestId);
      }
    },
  );

  // ---- MCP 只读（member）----
  app.get(
    "/hub/self/mcp/servers",
    { preHandler: readGuard, schema: { tags: ["hub-self"], summary: "查询本 namespace 可用 MCP server 池（只读，scope=信封头）" } },
    async (request, reply) => {
      const requestId = readRequestContext(request.headers).requestId;
      const servers = mcpService === null ? [] : await mcpService.listPool(selfScope(request));
      return sendData(reply, { servers }, 200, requestId);
    },
  );

  // ---- MCP mutation：恒 503 fail-closed（register/update/enable/disable/delete）----
  const mcpDisabled = async (request: FastifyRequest, reply: FastifyReply) =>
    capabilityDisabled(reply, readRequestContext(request.headers).requestId);
  app.post("/hub/self/mcp/servers", { schema: { tags: ["hub-self"], summary: "注册 MCP server（fail-closed，恒 503）" } }, mcpDisabled);
  app.post("/hub/self/mcp/servers/:name/enable", { schema: { tags: ["hub-self"], summary: "启用 MCP server（fail-closed，恒 503）" } }, mcpDisabled);
  app.post("/hub/self/mcp/servers/:name/disable", { schema: { tags: ["hub-self"], summary: "停用 MCP server（fail-closed，恒 503）" } }, mcpDisabled);
  app.delete("/hub/self/mcp/servers/:name", { schema: { tags: ["hub-self"], summary: "删除 MCP server（fail-closed，恒 503）" } }, mcpDisabled);
}

// self 启停：scope=信封头，name 从路径；required 官方技能拒关抛 SkillRequiredError → 409。
async function selfToggle(
  service: SkillHubService,
  request: FastifyRequest,
  reply: FastifyReply,
  enabled: boolean,
): Promise<FastifyReply> {
  const requestId = readRequestContext(request.headers).requestId;
  const params = nameParamsSchema.safeParse(request.params);
  if (!params.success) {
    return sendZodError(reply, params.error, requestId);
  }
  try {
    await service.setEnabled(selfScope(request), params.data.name, enabled);
    return sendData(reply, { ok: true }, 200, requestId);
  } catch (error) {
    if (error instanceof SkillRequiredError) {
      return sendError(reply, 409, "hub.skill_required", error.message, undefined, requestId);
    }
    request.log.error({ error }, "failed to toggle self skill enabled");
    return sendError(reply, 500, "hub.toggle_failed", "技能启停失败", undefined, requestId);
  }
}
