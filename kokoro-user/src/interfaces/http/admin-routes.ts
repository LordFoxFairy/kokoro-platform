import { registerAdminManifestRoute, sendData } from "@kokoro/platform-kit";
import type { FastifyInstance } from "fastify";
import type { UserRepository } from "../../domain/repository.js";
import { userAdminManifest } from "../admin/manifest.js";

// 每个 manifest resource id 映射到仓储只读 list 方法；未在此映射的资源不暴露端点。
function resourceLister(
  repository: UserRepository,
  resourceId: string,
): (() => Promise<unknown[]>) | undefined {
  switch (resourceId) {
    case "users":
      return () => repository.listUsers();
    case "teams":
      return () => repository.listTeams();
    case "memberships":
      return () => repository.listMemberships();
    case "service-accounts":
      return () => repository.listServiceAccounts();
    default:
      return undefined;
  }
}

export function registerUserAdminRoutes(app: FastifyInstance, repository: UserRepository): void {
  registerAdminManifestRoute(app, userAdminManifest);

  for (const resource of userAdminManifest.resources) {
    const lister = resourceLister(repository, resource.id);
    if (!lister) {
      continue;
    }

    app.get(resource.route, async (_request, reply) => sendData(reply, await lister()));
  }
}
