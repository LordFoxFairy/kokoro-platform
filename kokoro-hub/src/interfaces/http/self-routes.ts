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
import { ZodError } from "zod";
import type { McpHubService } from "../../application/mcp-hub-service.js";
import type { McpSecretService } from "../../application/mcp-secret-service.js";
import type { SkillHubService } from "../../application/skill-hub-service.js";
import type { SkillUploadService } from "../../application/skill-upload-service.js";
import { SkillRequiredError } from "../../domain/errors.js";
import { createSecretBodySchema, secretHandleParamsSchema } from "./mcp-secret-schemas.js";
import type { MembershipAuthorizer } from "./membership-authorizer.js";
import { parseSecretRef, selfRegisterMcpServerBodySchema } from "./mcp-server-ref.js";
import { validateMcpServerUrl } from "./mcp-url-guard.js";
import { McpServerNotFoundError } from "../../domain/errors.js";
import { nameParamsSchema } from "./schemas.js";
import { readSelfUploadPayload, replyUploadError, UPLOAD_BODY_LIMIT } from "./upload-routes.js";

const NAMESPACE_HEADER = "x-kokoro-namespace";
const USER_ID_HEADER = "x-kokoro-user-id";
// MCP 注册 fail-closed 门的稳定错误码（BFF/UI 据此显示“能力注册暂未开放”，而非当作 404）。
const CAPABILITY_DISABLED_CODE = "capability_registration_disabled";
// secret broker 未配置（无主密钥）时的稳定错误码：BFF/UI 据此显示“凭据保管未开放”。
const SECRET_BROKER_DISABLED_CODE = "secret_broker_disabled";

export interface SelfRouteServices {
  skillService: SkillHubService;
  uploadService: SkillUploadService;
  // 缺省 null = 无 MCP 仓储：MCP 只读面返回空池（mutation 仍恒 503）。
  mcpService: McpHubService | null;
  // 缺省 null = secret broker 未配置（无主密钥/仓储）：secret 面 503 fail-loud。
  secretService: McpSecretService | null;
  authorizer: MembershipAuthorizer;
  // MCP mutation 部署门（HUB-CONSIST 跨仓 E2E 过后开）：false = register/enable/disable/delete 恒 503。
  mcpMutationEnabled: boolean;
  // URL 预校验解析器注入口（测试用）；缺省用真 DNS（mcp-url-guard defaultResolver）。
  mcpUrlResolver?: (hostname: string) => Promise<string[]>;
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
  const { skillService, uploadService, mcpService, secretService, authorizer, mcpMutationEnabled } =
    services;
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

  // ---- MCP mutation（register/enable/disable/delete）----
  // 部署门 KOKORO_HUB_MCP_MUTATION：off → 恒 503 capability_registration_disabled（fail-closed）；
  // on → 经 writeGuard(owner/admin) + 全量防线（secret_ref 只收本 namespace handle: / URL 预校验）。
  const mcpDisabled = async (request: FastifyRequest, reply: FastifyReply) =>
    capabilityDisabled(reply, readRequestContext(request.headers).requestId);
  if (!mcpMutationEnabled || mcpService === null) {
    app.post("/hub/self/mcp/servers", { schema: { tags: ["hub-self"], summary: "注册 MCP server（fail-closed，恒 503）" } }, mcpDisabled);
    app.post("/hub/self/mcp/servers/:name/enable", { schema: { tags: ["hub-self"], summary: "启用 MCP server（fail-closed，恒 503）" } }, mcpDisabled);
    app.post("/hub/self/mcp/servers/:name/disable", { schema: { tags: ["hub-self"], summary: "停用 MCP server（fail-closed，恒 503）" } }, mcpDisabled);
    app.delete("/hub/self/mcp/servers/:name", { schema: { tags: ["hub-self"], summary: "删除 MCP server（fail-closed，恒 503）" } }, mcpDisabled);
  } else {
    const mcp = mcpService;
    app.post(
      "/hub/self/mcp/servers",
      { preHandler: writeGuard, schema: { tags: ["hub-self"], summary: "注册本 namespace MCP server（scope=信封头；secret_ref 仅 handle:；URL 预校验）" } },
      (request, reply) => selfRegisterMcp(mcp, secretService, services.mcpUrlResolver, request, reply),
    );
    app.post(
      "/hub/self/mcp/servers/:name/enable",
      { preHandler: writeGuard, schema: { tags: ["hub-self"], summary: "启用本 namespace MCP server（文档级开关）" } },
      (request, reply) => selfToggleMcp(mcp, request, reply, true),
    );
    app.post(
      "/hub/self/mcp/servers/:name/disable",
      { preHandler: writeGuard, schema: { tags: ["hub-self"], summary: "停用本 namespace MCP server（文档级开关，对旧会话即刻 fail-closed）" } },
      (request, reply) => selfToggleMcp(mcp, request, reply, false),
    );
    app.delete(
      "/hub/self/mcp/servers/:name",
      { preHandler: writeGuard, schema: { tags: ["hub-self"], summary: "软删本 namespace MCP server（置 deleted_at，旧会话即刻 fail-closed）" } },
      (request, reply) => selfDeleteMcp(mcp, request, reply),
    );
  }

  // ---- MCP secret broker（self 面）：创建（写）/ 列表（读）/ 软删（写）----
  // 明文只进不出：创建收 value 即加密落库，响应只回句柄；列表/删除面绝不含值或密文。
  app.post(
    "/hub/self/mcp/secrets",
    { preHandler: writeGuard, schema: { tags: ["hub-self"], summary: "保管一条 MCP 凭据（value 只进不出，回不透明句柄）" } },
    (request, reply) => createSecret(secretService, request, reply),
  );
  app.get(
    "/hub/self/mcp/secrets",
    { preHandler: readGuard, schema: { tags: ["hub-self"], summary: "列出本 namespace 已保管凭据（只出句柄/命名/创建时间）" } },
    async (request, reply) => {
      const requestId = readRequestContext(request.headers).requestId;
      if (secretService === null) {
        return secretBrokerDisabled(reply, requestId);
      }
      const secrets = await secretService.list(selfScope(request));
      return sendData(reply, { secrets }, 200, requestId);
    },
  );
  app.delete(
    "/hub/self/mcp/secrets/:handle",
    { preHandler: writeGuard, schema: { tags: ["hub-self"], summary: "软删一条已保管凭据（幂等，仅限本 namespace）" } },
    (request, reply) => deleteSecret(secretService, request, reply),
  );
}

function secretBrokerDisabled(reply: FastifyReply, requestId: string): FastifyReply {
  return sendError(
    reply,
    503,
    SECRET_BROKER_DISABLED_CODE,
    "凭据保管暂未开放（未配置 secret 主密钥）",
    undefined,
    requestId,
  );
}

// self 创建凭据：scope=信封头，value 只进不出——错误面绝不回显 value/密文。
async function createSecret(
  secretService: McpSecretService | null,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const requestId = readRequestContext(request.headers).requestId;
  if (secretService === null) {
    return secretBrokerDisabled(reply, requestId);
  }
  try {
    const body = createSecretBodySchema.parse(request.body);
    const created = await secretService.create(selfScope(request), body.name, body.value);
    return sendData(reply, created, 201, requestId);
  } catch (error) {
    if (error instanceof ZodError) {
      return sendZodError(reply, error, requestId);
    }
    // 绝不把 error（可能内联 body/value）带进日志或响应：只记 handle 无关的通用面。
    request.log.error("failed to store mcp secret");
    return sendError(reply, 500, "hub.secret_store_failed", "凭据保管失败", undefined, requestId);
  }
}

// self 软删凭据：句柄形状钉死，幂等（不存在/跨 scope 静默通过，不泄露存在性）。
async function deleteSecret(
  secretService: McpSecretService | null,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const requestId = readRequestContext(request.headers).requestId;
  if (secretService === null) {
    return secretBrokerDisabled(reply, requestId);
  }
  const params = secretHandleParamsSchema.safeParse(request.params);
  if (!params.success) {
    return sendZodError(reply, params.error, requestId);
  }
  await secretService.delete(selfScope(request), params.data.handle);
  return sendData(reply, { ok: true }, 200, requestId);
}

// self 注册 MCP server（门后）：scope=信封头，body 不收 scope（strict）；secret_ref 仅 handle: 且须∈本 namespace；
// URL 静态预校验（https + 解析后不落私网/元数据网段）。凭据本体绝不入库，只存 handle 引用。
async function selfRegisterMcp(
  mcpService: McpHubService,
  secretService: McpSecretService | null,
  urlResolver: ((hostname: string) => Promise<string[]>) | undefined,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const requestId = readRequestContext(request.headers).requestId;
  const parsed = selfRegisterMcpServerBodySchema.safeParse(request.body);
  if (!parsed.success) {
    return sendZodError(reply, parsed.error, requestId);
  }
  const body = parsed.data;
  const scope = selfScope(request);
  // secret_ref 归属校验：handle: 形状已由 schema 保证；此处核验句柄属本 namespace 且活跃。
  const secretRef = body.secret_ref ?? null;
  if (secretRef !== null) {
    const ref = parseSecretRef(secretRef);
    if (ref.kind !== "handle") {
      return sendError(reply, 400, "hub.mcp_secret_ref_invalid", "self secret_ref 仅接受本 namespace 的 handle: 引用", undefined, requestId);
    }
    const owned = secretService !== null && (await secretService.owns(scope, ref.handle));
    if (!owned) {
      return sendError(reply, 400, "hub.mcp_secret_ref_unknown", "secret_ref 句柄不属本 namespace 或不存在", undefined, requestId);
    }
  }
  // URL 预校验（self 面恒 https，不放行私网/元数据）：DNS 全量解析逐 IP 判网段。
  const urlCheck = await validateMcpServerUrl(body.url, {
    allowInsecure: false,
    ...(urlResolver !== undefined ? { resolver: urlResolver } : {}),
  });
  if (!urlCheck.ok) {
    return sendError(reply, 400, "hub.mcp_url_forbidden", `MCP url 预校验未通过：${urlCheck.reason}`, undefined, requestId);
  }
  const server = await mcpService.register({
    scope,
    name: body.name,
    transport: body.transport,
    url: body.url,
    allowedTools: body.allowed_tools,
    secretRef,
  });
  return sendData(reply, { server }, 201, requestId);
}

// self 启停 MCP server：scope=信封头，name 从路径；目标不存在/已软删 → 404。
async function selfToggleMcp(
  mcpService: McpHubService,
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
    await mcpService.setEnabled(selfScope(request), params.data.name, enabled);
    return sendData(reply, { ok: true }, 200, requestId);
  } catch (error) {
    if (error instanceof McpServerNotFoundError) {
      return sendError(reply, 404, "hub.mcp_server_not_found", error.message, undefined, requestId);
    }
    request.log.error({ error }, "failed to toggle self mcp server");
    return sendError(reply, 500, "hub.mcp_toggle_failed", "MCP server 启停失败", undefined, requestId);
  }
}

// self 软删 MCP server：scope=信封头，name 从路径；幂等（对齐 admin 面）。
async function selfDeleteMcp(
  mcpService: McpHubService,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const requestId = readRequestContext(request.headers).requestId;
  const params = nameParamsSchema.safeParse(request.params);
  if (!params.success) {
    return sendZodError(reply, params.error, requestId);
  }
  await mcpService.markDeleted(selfScope(request), params.data.name);
  return sendData(reply, { ok: true }, 200, requestId);
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
