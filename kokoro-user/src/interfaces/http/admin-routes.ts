import { registerAdminManifestRoute, sendData, sendError } from "@kokoro/platform-kit";
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
      return (siteId) => repository.listUsers(siteId);
    case "teams":
      return (siteId) => repository.listTeams(siteId);
    case "memberships":
      return () => repository.listMemberships();
    case "service-accounts":
      return () => repository.listServiceAccounts();
    default:
      return undefined;
  }
}

// ?siteId= 是不可信查询串，用 Zod 洗净；缺省/空白/非字符串都降级为未传（全量）。
const siteIdQuerySchema = z
  .object({ siteId: z.string().trim().min(1).optional() })
  .catch({ siteId: undefined });

function siteIdQuery(query: unknown): string | undefined {
  return siteIdQuerySchema.parse(query).siteId;
}

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

    app.get(resource.route, async (request, reply) =>
      sendData(reply, await lister(siteIdQuery(request.query))),
    );
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
