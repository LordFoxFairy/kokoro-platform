import { jsonSchema, registerHealthRoute, sendData, sendError, sendZodError } from "@kokoro/platform-kit";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import type { SiteService } from "../../application/site-service.js";
import { isSiteLifecycleError } from "../../domain/site-deletion.js";
import {
  deleteRequestSchema,
  listSiteFeatureFlagsQuerySchema,
  resolveSiteQuerySchema,
  siteActiveParamsSchema,
  siteDomainParamsSchema,
  siteParamsSchema,
  upsertSiteAppRequestSchema,
  upsertSiteDomainRequestSchema,
  upsertSiteFeatureFlagRequestSchema,
  upsertSitePolicyRequestSchema,
  upsertSiteRequestSchema,
} from "./schemas.js";

export function registerSiteRoutes(app: FastifyInstance, service: SiteService): void {
  registerHealthRoute(app, "site");

  app.get("/sites", { schema: { tags: ["site"], summary: "列出所有站点" } }, async (request, reply) => {
    const requestId = getRequestId(request.headers["x-request-id"]);

    try {
      const sites = await service.listSites();
      return sendData(reply, sites, 200, requestId);
    } catch (error) {
      request.log.error({ error }, "failed to list sites");
      return sendError(reply, 500, "site.list_failed", "站点列表获取失败", undefined, requestId);
    }
  });

  // 下游(credit/payment)记账前调用：校验站点是否 active。
  app.get(
    "/sites/:siteId/active",
    { schema: { tags: ["site"], summary: "校验站点是否 active" } },
    async (request, reply) => {
      const requestId = getRequestId(request.headers["x-request-id"]);
      const params = siteActiveParamsSchema.safeParse(request.params);
      if (!params.success) {
        return sendZodError(reply, params.error, requestId);
      }
      const active = await service.resolveSiteActive(params.data.siteId);
      return sendData(reply, { active }, 200, requestId);
    },
  );

  app.delete(
    "/sites/:siteId",
    { schema: { tags: ["site"], summary: "删除站点", body: jsonSchema(deleteRequestSchema) } },
    async (request, reply) => {
      const requestId = getRequestId(request.headers["x-request-id"]);

      try {
        const params = siteParamsSchema.parse(request.params);
        const body = deleteRequestSchema.parse(request.body ?? {});
        const site = await service.deleteSite({ id: params.siteId, ...body });
        return sendData(reply, site, 200, requestId);
      } catch (error) {
        return handleRouteError(request, reply, error, requestId, "site.delete_failed", "站点删除失败");
      }
    },
  );

  app.post(
    "/sites/:siteId/restore",
    { schema: { tags: ["site"], summary: "恢复站点" } },
    async (request, reply) => {
      const requestId = getRequestId(request.headers["x-request-id"]);

      try {
        const params = siteParamsSchema.parse(request.params);
        const site = await service.restoreSite({ id: params.siteId });
        return sendData(reply, site, 200, requestId);
      } catch (error) {
        return handleRouteError(request, reply, error, requestId, "site.restore_failed", "站点恢复失败");
      }
    },
  );

  app.post(
    "/sites/upsert",
    { schema: { tags: ["site"], summary: "创建或更新站点", body: jsonSchema(upsertSiteRequestSchema) } },
    async (request, reply) => {
      const requestId = getRequestId(request.headers["x-request-id"]);

      try {
        const input = upsertSiteRequestSchema.parse(request.body);
        const site = await service.upsertSite(input);
        return sendData(reply, site, 200, requestId);
      } catch (error) {
        return handleRouteError(request, reply, error, requestId, "site.upsert_failed", "站点保存失败");
      }
    },
  );

  app.post(
    "/site-domains/upsert",
    { schema: { tags: ["site"], summary: "创建或更新站点域名", body: jsonSchema(upsertSiteDomainRequestSchema) } },
    async (request, reply) => {
      const requestId = getRequestId(request.headers["x-request-id"]);

      try {
        const input = upsertSiteDomainRequestSchema.parse(request.body);
        const domain = await service.upsertSiteDomain(input);
        return sendData(reply, domain, 200, requestId);
      } catch (error) {
        return handleRouteError(request, reply, error, requestId, "site_domain.upsert_failed", "站点域名保存失败");
      }
    },
  );

  app.delete(
    "/site-domains/:domainId",
    { schema: { tags: ["site"], summary: "删除站点域名", body: jsonSchema(deleteRequestSchema) } },
    async (request, reply) => {
      const requestId = getRequestId(request.headers["x-request-id"]);

      try {
        const params = siteDomainParamsSchema.parse(request.params);
        const body = deleteRequestSchema.parse(request.body ?? {});
        const domain = await service.deleteSiteDomain({ id: params.domainId, ...body });
        return sendData(reply, domain, 200, requestId);
      } catch (error) {
        return handleRouteError(request, reply, error, requestId, "site_domain.delete_failed", "站点域名删除失败");
      }
    },
  );

  app.post(
    "/site-domains/:domainId/restore",
    { schema: { tags: ["site"], summary: "恢复站点域名" } },
    async (request, reply) => {
      const requestId = getRequestId(request.headers["x-request-id"]);

      try {
        const params = siteDomainParamsSchema.parse(request.params);
        const domain = await service.restoreSiteDomain({ id: params.domainId });
        return sendData(reply, domain, 200, requestId);
      } catch (error) {
        return handleRouteError(request, reply, error, requestId, "site_domain.restore_failed", "站点域名恢复失败");
      }
    },
  );

  app.post(
    "/site-apps/upsert",
    { schema: { tags: ["site"], summary: "创建或更新站点应用", body: jsonSchema(upsertSiteAppRequestSchema) } },
    async (request, reply) => {
      const requestId = getRequestId(request.headers["x-request-id"]);

      try {
        const input = upsertSiteAppRequestSchema.parse(request.body);
        const siteApp = await service.upsertSiteApp(input);
        return sendData(reply, siteApp, 200, requestId);
      } catch (error) {
        return handleRouteError(request, reply, error, requestId, "site_app.upsert_failed", "站点应用保存失败");
      }
    },
  );

  app.post(
    "/site-policies/upsert",
    { schema: { tags: ["site"], summary: "创建或更新站点策略", body: jsonSchema(upsertSitePolicyRequestSchema) } },
    async (request, reply) => {
      const requestId = getRequestId(request.headers["x-request-id"]);

      try {
        const input = upsertSitePolicyRequestSchema.parse(request.body);
        const policy = await service.upsertSitePolicy(input);
        return sendData(reply, policy, 200, requestId);
      } catch (error) {
        return handleRouteError(request, reply, error, requestId, "site_policy.upsert_failed", "站点策略保存失败");
      }
    },
  );

  app.post(
    "/site-feature-flags/upsert",
    {
      schema: {
        tags: ["site"],
        summary: "创建或更新站点功能开关",
        body: jsonSchema(upsertSiteFeatureFlagRequestSchema),
      },
    },
    async (request, reply) => {
      const requestId = getRequestId(request.headers["x-request-id"]);

      try {
        const input = upsertSiteFeatureFlagRequestSchema.parse(request.body);
        const flag = await service.upsertSiteFeatureFlag(input);
        return sendData(reply, flag, 200, requestId);
      } catch (error) {
        return handleRouteError(
          request,
          reply,
          error,
          requestId,
          "site_feature_flag.upsert_failed",
          "站点功能开关保存失败",
        );
      }
    },
  );

  app.get(
    "/site-feature-flags",
    { schema: { tags: ["site"], summary: "列出站点功能开关" } },
    async (request, reply) => {
      const requestId = getRequestId(request.headers["x-request-id"]);

      try {
        const input = listSiteFeatureFlagsQuerySchema.parse(withHeaderSiteId(request));
        const flags = await service.listSiteFeatureFlags(input.siteId);
        return sendData(reply, flags, 200, requestId);
      } catch (error) {
        return handleRouteError(
          request,
          reply,
          error,
          requestId,
          "site_feature_flag.list_failed",
          "站点功能开关列表获取失败",
        );
      }
    },
  );

  app.get(
    "/site-context/resolve",
    { schema: { tags: ["site"], summary: "按域名解析站点上下文" } },
    async (request, reply) => {
      const requestId = getRequestId(request.headers["x-request-id"]);

      try {
        const input = resolveSiteQuerySchema.parse(request.query);
        const context = await service.resolveSiteContext(input);

        if (!context) {
          return sendError(reply, 404, "site_context.not_found", "站点上下文不存在", undefined, requestId);
        }

        return sendData(reply, context, 200, requestId);
      } catch (error) {
        return handleRouteError(request, reply, error, requestId, "site_context.resolve_failed", "站点上下文解析失败");
      }
    },
  );
}

function handleRouteError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
  requestId: string,
  code: string,
  message: string,
) {
  if (error instanceof ZodError) {
    return sendZodError(reply, error, requestId);
  }

  if (isSiteLifecycleError(error)) {
    return sendError(reply, error.statusCode, error.code, error.message, undefined, requestId);
  }

  request.log.error({ error }, message);
  return sendError(reply, 500, code, message, undefined, requestId);
}

// siteId 优先取 query；缺省时回落到 x-kokoro-site-id header，再交 strict schema 校验。
function withHeaderSiteId(request: FastifyRequest): Record<string, unknown> {
  const query: Record<string, unknown> =
    typeof request.query === "object" && request.query !== null && !Array.isArray(request.query)
      ? { ...request.query }
      : {};
  if (query["siteId"] === undefined) {
    const header = getSingleHeader(request.headers["x-kokoro-site-id"]);
    if (header !== undefined) {
      query["siteId"] = header;
    }
  }
  return query;
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
