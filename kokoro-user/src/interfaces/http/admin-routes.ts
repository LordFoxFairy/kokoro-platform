import { registerAdminManifestRoute, sendData, sendError, sendZodError } from "@kokoro/platform-kit";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { UserService } from "../../application/user-service.js";
import { UserNotFoundError } from "../../domain/errors.js";
import type { UserRepository } from "../../domain/repository.js";
import type { User } from "../../domain/user.js";
import { userAdminManifest } from "../admin/manifest.js";

// 每个 manifest resource id 映射到仓储只读 list 方法；未在此映射的资源不暴露端点。
// users/teams 透传可选 siteId 过滤（不传=全量平台视图）；其余资源忽略该参数。
function resourceLister(
  repository: UserRepository,
  resourceId: string,
): ((siteId?: string) => Promise<unknown[]>) | undefined {
  switch (resourceId) {
    case "users":
      return (siteId) => repository.listUsers(siteId, { includeDeleted: true });
    case "teams":
      return (siteId) => repository.listTeams(siteId, { includeDeleted: true });
    case "memberships":
      return (siteId) => repository.listMemberships(siteId, { includeDeleted: true });
    case "service-accounts":
      return (siteId) => repository.listServiceAccounts(siteId, { includeDeleted: true });
    default:
      return undefined;
  }
}

const siteIdQuerySchema = z.object({ siteId: z.string().trim().min(1).optional() }).strict();

export function registerUserAdminRoutes(
  app: FastifyInstance,
  repository: UserRepository,
  service: UserService,
): void {
  registerAdminManifestRoute(app, userAdminManifest);

  for (const resource of userAdminManifest.resources) {
    const lister = resourceLister(repository, resource.id);
    if (!lister) {
      continue;
    }

    app.get(resource.route, async (request, reply) => {
      const query = siteIdQuerySchema.safeParse(request.query);
      if (!query.success) return sendZodError(reply, query.error);
      return sendData(reply, await lister(query.data.siteId));
    });
  }

  app.post<UserIdRoute>("/admin/users/:id/disable", async (request, reply) =>
    runStatusMutation(reply, () => service.disableUser(request.params.id)),
  );

  app.post<UserIdRoute>("/admin/users/:id/enable", async (request, reply) =>
    runStatusMutation(reply, () => service.enableUser(request.params.id)),
  );
}

interface UserIdRoute {
  Params: { id: string };
}

async function runStatusMutation(
  reply: Parameters<typeof sendData>[0],
  mutate: () => Promise<User>,
) {
  try {
    return sendData(reply, await mutate());
  } catch (error) {
    if (error instanceof UserNotFoundError) {
      return sendError(reply, 404, "user.not_found", "用户不存在");
    }
    throw error;
  }
}
