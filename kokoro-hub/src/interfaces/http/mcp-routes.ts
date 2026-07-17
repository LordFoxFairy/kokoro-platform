// MCP server 注册表路由（HUB-3）：注册即 upsert / 池查询（official+namespace 合并）/
// 文档级启停 / 软删。凭据只收 env/secret 引用（形状在 mcp-schemas 钉死），绝不明文入库。

import {
  jsonSchema,
  readRequestContext,
  sendData,
  sendError,
  sendZodError,
} from "@kokoro/platform-kit";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import type { McpHubService } from "../../application/mcp-hub-service.js";
import { McpServerNotFoundError } from "../../domain/errors.js";
import { OFFICIAL_SCOPE } from "../../domain/constants.js";
import { registerMcpServerBodySchema } from "./mcp-schemas.js";
import { nameParamsSchema, namespaceQuerySchema, scopeNameParamsSchema } from "./schemas.js";

export function registerMcpRoutes(app: FastifyInstance, service: McpHubService): void {
  app.post(
    "/hub/admin/mcp/servers",
    {
      schema: {
        tags: ["hub"],
        summary: "注册/更新 MCP server（凭据只收 env/secret 引用，明文拒收）",
        body: jsonSchema(registerMcpServerBodySchema),
      },
    },
    async (request, reply) => {
      const requestId = readRequestContext(request.headers).requestId;
      try {
        const body = registerMcpServerBodySchema.parse(request.body);
        const server = await service.register({
          scope: body.scope,
          name: body.name,
          transport: body.transport,
          url: body.url,
          allowedTools: body.allowed_tools,
          secretRef: body.secret_ref ?? null,
        });
        return sendData(reply, { server }, 201, requestId);
      } catch (error) {
        if (error instanceof ZodError) {
          return sendZodError(reply, error, requestId);
        }
        request.log.error({ error }, "failed to register mcp server");
        return sendError(reply, 500, "hub.mcp_register_failed", "MCP server 注册失败", undefined, requestId);
      }
    },
  );

  app.get(
    "/hub/admin/mcp/servers",
    { schema: { tags: ["hub"], summary: "查询某 namespace 的可用 MCP server 池" } },
    async (request, reply) => {
      const requestId = readRequestContext(request.headers).requestId;
      const query = namespaceQuerySchema.safeParse(request.query);
      if (!query.success) {
        return sendZodError(reply, query.error, requestId);
      }
      const servers = await service.listPool(query.data.namespace);
      return sendData(reply, { servers }, 200, requestId);
    },
  );

  // 运营 admin 面:全部官方 MCP server 目录（namespace-free,治理视图,含禁用项）。数组直包 data,
  // 对齐通用运营网关 resourceEnvelope { data: [...] };行内动作(enable/disable/delete)以 :name 单参操作。
  app.get(
    "/hub/admin/official/mcp/servers",
    { schema: { tags: ["hub"], summary: "运营:全部官方 MCP server 目录（治理视图）" } },
    async (request, reply) => {
      const requestId = readRequestContext(request.headers).requestId;
      const cards = await service.listOfficialCatalog();
      return sendData(reply, cards, 200, requestId);
    },
  );

  // 单参官方启停/软删（scope=official 隐含）：通用网关按 :name 解析，无需在 UI 拼 scope。
  app.post(
    "/hub/admin/official/mcp/servers/:name/enable",
    { schema: { tags: ["hub"], summary: "运营:启用官方 MCP server（文档级开关）" } },
    (request, reply) => toggleOfficialEnabled(service, request, reply, true),
  );

  app.post(
    "/hub/admin/official/mcp/servers/:name/disable",
    { schema: { tags: ["hub"], summary: "运营:停用官方 MCP server（文档级开关）" } },
    (request, reply) => toggleOfficialEnabled(service, request, reply, false),
  );

  app.delete(
    "/hub/admin/official/mcp/servers/:name",
    { schema: { tags: ["hub"], summary: "运营:软删官方 MCP server（置 deleted_at；重注册可复活）" } },
    async (request, reply) => {
      const requestId = readRequestContext(request.headers).requestId;
      try {
        const params = nameParamsSchema.parse(request.params);
        await service.markDeleted(OFFICIAL_SCOPE, params.name);
        return sendData(reply, { ok: true }, 200, requestId);
      } catch (error) {
        if (error instanceof ZodError) {
          return sendZodError(reply, error, requestId);
        }
        request.log.error({ error }, "failed to soft delete official mcp server");
        return sendError(reply, 500, "hub.mcp_delete_failed", "MCP server 删除失败", undefined, requestId);
      }
    },
  );

  app.post(
    "/hub/admin/mcp/servers/:scope/:name/enable",
    { schema: { tags: ["hub"], summary: "启用某 MCP server（文档级开关）" } },
    (request, reply) => toggleEnabled(service, request, reply, true),
  );

  app.post(
    "/hub/admin/mcp/servers/:scope/:name/disable",
    { schema: { tags: ["hub"], summary: "停用某 MCP server（文档级开关）" } },
    (request, reply) => toggleEnabled(service, request, reply, false),
  );

  app.delete(
    "/hub/admin/mcp/servers/:scope/:name",
    { schema: { tags: ["hub"], summary: "软删某 MCP server（置 deleted_at；重注册可复活）" } },
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
        request.log.error({ error }, "failed to soft delete mcp server");
        return sendError(reply, 500, "hub.mcp_delete_failed", "MCP server 删除失败", undefined, requestId);
      }
    },
  );
}

// 运营单参启停：scope=official 隐含,复用文档级启停语义。
async function toggleOfficialEnabled(
  service: McpHubService,
  request: FastifyRequest,
  reply: FastifyReply,
  enabled: boolean,
) {
  const requestId = readRequestContext(request.headers).requestId;
  try {
    const params = nameParamsSchema.parse(request.params);
    await service.setEnabled(OFFICIAL_SCOPE, params.name, enabled);
    return sendData(reply, { ok: true }, 200, requestId);
  } catch (error) {
    if (error instanceof ZodError) {
      return sendZodError(reply, error, requestId);
    }
    if (error instanceof McpServerNotFoundError) {
      return sendError(reply, 404, "hub.mcp_server_not_found", error.message, undefined, requestId);
    }
    request.log.error({ error }, "failed to toggle official mcp server enabled");
    return sendError(reply, 500, "hub.mcp_toggle_failed", "MCP server 启停失败", undefined, requestId);
  }
}

// 启停共用：enabled 是文档级状态（键 = scope+name），与 skills 的 per-user 偏好轴不同，无需 body。
async function toggleEnabled(
  service: McpHubService,
  request: FastifyRequest,
  reply: FastifyReply,
  enabled: boolean,
) {
  const requestId = readRequestContext(request.headers).requestId;
  try {
    const params = scopeNameParamsSchema.parse(request.params);
    await service.setEnabled(params.scope, params.name, enabled);
    return sendData(reply, { ok: true }, 200, requestId);
  } catch (error) {
    if (error instanceof ZodError) {
      return sendZodError(reply, error, requestId);
    }
    if (error instanceof McpServerNotFoundError) {
      return sendError(reply, 404, "hub.mcp_server_not_found", error.message, undefined, requestId);
    }
    request.log.error({ error }, "failed to toggle mcp server enabled");
    return sendError(reply, 500, "hub.mcp_toggle_failed", "MCP server 启停失败", undefined, requestId);
  }
}
