// runtime 面路由（HUB-AUTHZ）：仅 runtime caller(session/agent)。按已验 namespace 返回有效池。
// /hub/runtime/skills/pool 迁自旧 /hub/skills/pool；/hub/runtime/resolve 是聚合出口，
// 为 HUB-CONSIST 的 session 单解析器准备（先返回 skills 卡片 + 现 mcp_servers names 视图）。
// /hub/runtime/mcp/secrets/resolve 是 secret 明文的唯一授权出口（装配期换明文进 headers）。

import { readRequestContext, sendData, sendError, sendZodError } from "@kokoro/platform-kit";
import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { McpHubService } from "../../application/mcp-hub-service.js";
import type { McpSecretService } from "../../application/mcp-secret-service.js";
import type { SkillHubService } from "../../application/skill-hub-service.js";
import { SecretNotResolvableError } from "../../domain/errors.js";
import { SecretDecryptError } from "../../domain/secret-cipher.js";
import { resolveSecretsBodySchema } from "./mcp-secret-schemas.js";
import { namespaceQuerySchema } from "./schemas.js";

export interface RuntimeRouteServices {
  skillService: SkillHubService;
  mcpService: McpHubService | null;
  // 缺省 null = secret broker 未配置：resolve 面 503 fail-loud。
  secretService: McpSecretService | null;
}

export function registerRuntimeRoutes(app: FastifyInstance, services: RuntimeRouteServices): void {
  const { skillService, mcpService, secretService } = services;

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

  // secret 明文唯一授权出口：runtime caller 按已验 namespace 批解句柄→明文（装配期进 headers，仅驻内存）。
  // 跨 namespace/不存在/已删句柄一律 404（全有或全无，不回显句柄，不泄露存在性）。
  app.post(
    "/hub/runtime/mcp/secrets/resolve",
    { schema: { tags: ["hub-runtime"], summary: "按 namespace 批量解析凭据句柄为明文（装配期换明文）" } },
    async (request, reply) => {
      const requestId = readRequestContext(request.headers).requestId;
      if (secretService === null) {
        return sendError(reply, 503, "secret_broker_disabled", "凭据保管暂未开放（未配置 secret 主密钥）", undefined, requestId);
      }
      const body = resolveSecretsBodySchema.safeParse(request.body);
      if (!body.success) {
        return sendZodError(reply, body.error, requestId);
      }
      try {
        const secrets = await secretService.resolve(body.data.namespace, body.data.handles);
        return sendData(reply, { secrets }, 200, requestId);
      } catch (error) {
        if (error instanceof ZodError) {
          return sendZodError(reply, error, requestId);
        }
        if (error instanceof SecretNotResolvableError) {
          // 跨 namespace 与纯粹不存在返回同一 404 面，不回显是哪个句柄。
          return sendError(reply, 404, "hub.secret_not_found", "一个或多个凭据在本 namespace 不可解析", undefined, requestId);
        }
        if (error instanceof SecretDecryptError) {
          // 解密失败（信封损坏/密钥不匹配）：通用 500，绝不回显密文/明文。
          request.log.error("failed to decrypt mcp secret at resolve");
          return sendError(reply, 500, "hub.secret_decrypt_failed", "凭据解析失败", undefined, requestId);
        }
        request.log.error("failed to resolve mcp secrets");
        return sendError(reply, 500, "hub.secret_resolve_failed", "凭据解析失败", undefined, requestId);
      }
    },
  );
}
