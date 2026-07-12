// runtime 面路由（HUB-AUTHZ）：仅 runtime caller(session/agent)。按已验 namespace 返回有效池。
// /hub/runtime/skills/pool 迁自旧 /hub/skills/pool；/hub/runtime/resolve 是聚合出口，
// 为 HUB-CONSIST 的 session 单解析器准备（先返回 skills 卡片 + 现 mcp_servers names 视图）。

import { readRequestContext, sendData, sendZodError } from "@kokoro/platform-kit";
import type { FastifyInstance } from "fastify";
import type { McpHubService } from "../../application/mcp-hub-service.js";
import type { SkillHubService } from "../../application/skill-hub-service.js";
import { namespaceQuerySchema } from "./schemas.js";

export function registerRuntimeRoutes(
  app: FastifyInstance,
  skillService: SkillHubService,
  mcpService: McpHubService | null,
): void {
  app.get(
    "/hub/runtime/skills/pool",
    { schema: { tags: ["hub-runtime"], summary: "运行时按 namespace 查询可用技能池" } },
    async (request, reply) => {
      const requestId = readRequestContext(request.headers).requestId;
      const query = namespaceQuerySchema.safeParse(request.query);
      if (!query.success) {
        return sendZodError(reply, query.error, requestId);
      }
      const skills = await skillService.listPool(query.data.namespace);
      return sendData(reply, { skills }, 200, requestId);
    },
  );

  app.get(
    "/hub/runtime/resolve",
    {
      schema: {
        tags: ["hub-runtime"],
        summary: "运行时聚合解析：按 namespace 返回有效 skills + mcp_servers 名称视图",
      },
    },
    async (request, reply) => {
      const requestId = readRequestContext(request.headers).requestId;
      const query = namespaceQuerySchema.safeParse(request.query);
      if (!query.success) {
        return sendZodError(reply, query.error, requestId);
      }
      const skills = await skillService.listPool(query.data.namespace);
      // 现阶段只出 names 视图；HUB-CONSIST 落 McpGrant{scope,name,revision,config_hash} 后再扩展。
      const servers = mcpService === null ? [] : await mcpService.listPool(query.data.namespace);
      const mcpServers = servers.map((server) => server.name);
      return sendData(reply, { skills, mcp_servers: mcpServers }, 200, requestId);
    },
  );
}
