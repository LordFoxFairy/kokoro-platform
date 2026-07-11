import { registerAdminManifestRoute, sendData, sendError } from "@kokoro/platform-kit";
import type { FastifyInstance } from "fastify";
import type { SiteRepository } from "../../domain/repository.js";
import { siteAdminManifest } from "../admin/manifest.js";

// 后台只读 API：暴露 manifest + 每个资源的 list 端点（按 manifest.route 注册）。
export function registerSiteAdminRoutes(app: FastifyInstance, repository: SiteRepository): void {
  registerAdminManifestRoute(app, siteAdminManifest);

  const listByResourceId: Record<string, () => Promise<unknown[]>> = {
    sites: () => repository.listAdminSites({ includeDeleted: true }),
    domains: () => repository.listAdminSiteDomains({ includeDeleted: true }),
    apps: () => repository.listAdminSiteApps({ includeDeleted: true }),
    policies: () => repository.listAdminSitePolicies({ includeDeleted: true }),
    "feature-flags": () => repository.listAdminSiteFeatureFlags({ includeDeleted: true }),
  };

  for (const resource of siteAdminManifest.resources) {
    const list = listByResourceId[resource.id];
    if (!list) {
      throw new Error(`no admin list handler for site resource: ${resource.id}`);
    }

    app.get(resource.route, async (request, reply) => {
      const requestId = getRequestId(request.headers["x-kokoro-request-id"] ?? request.headers["x-request-id"]);

      try {
        return sendData(reply, await list(), 200, requestId);
      } catch (error) {
        request.log.error({ error }, `failed to list admin ${resource.id}`);
        return sendError(reply, 500, `admin.${resource.id}.list_failed`, "后台列表获取失败", undefined, requestId);
      }
    });
  }
}

function getRequestId(value: string | string[] | undefined): string {
  const single = Array.isArray(value) ? value[0] : value;
  const normalized = single?.trim();
  return normalized ? normalized : crypto.randomUUID();
}
