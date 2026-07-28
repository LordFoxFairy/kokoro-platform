import { registerAdminManifestRoute, sendData, sendError, sendZodError } from "@kokoro/platform-kit";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { SiteRepository } from "../../domain/repository.js";
import { siteAdminManifest } from "../admin/manifest.js";

// 后台只读 API：暴露 manifest + 每个资源的 list 端点（按 manifest.route 注册）。
export function registerSiteAdminRoutes(app: FastifyInstance, repository: SiteRepository): void {
  registerAdminManifestRoute(app, siteAdminManifest);

  const listByResourceId: Record<string, (siteId?: string) => Promise<unknown[]>> = {
    sites: (siteId) => repository.listAdminSites({ includeDeleted: true, siteId }),
    domains: (siteId) => repository.listAdminSiteDomains({ includeDeleted: true, siteId }),
    apps: (siteId) => repository.listAdminSiteApps({ includeDeleted: true, siteId }),
    policies: (siteId) => repository.listAdminSitePolicies({ includeDeleted: true, siteId }),
    "feature-flags": (siteId) => repository.listAdminSiteFeatureFlags({ includeDeleted: true, siteId }),
  };

  for (const resource of siteAdminManifest.resources) {
    const list = listByResourceId[resource.id];
    if (!list) {
      throw new Error(`no admin list handler for site resource: ${resource.id}`);
    }

    app.get(resource.route, async (request, reply) => {
      const requestId = getRequestId(request.headers["x-kokoro-request-id"] ?? request.headers["x-request-id"]);
      const query = adminListQuerySchema.safeParse(request.query);
      if (!query.success) {
        return sendZodError(reply, query.error, requestId);
      }

      try {
        return sendData(reply, await list(query.data.siteId), 200, requestId);
      } catch (error) {
        request.log.error({ error }, `failed to list admin ${resource.id}`);
        return sendError(reply, 500, `admin.${resource.id}.list_failed`, "后台列表获取失败", undefined, requestId);
      }
    });
  }
}

const adminListQuerySchema = z
  .object({ siteId: z.string().trim().min(1).refine((siteId) => siteId !== "*").optional() })
  .strict();

function getRequestId(value: string | string[] | undefined): string {
  const single = Array.isArray(value) ? value[0] : value;
  const normalized = single?.trim();
  return normalized ? normalized : crypto.randomUUID();
}
