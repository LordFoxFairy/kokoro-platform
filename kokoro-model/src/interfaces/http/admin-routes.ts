import { registerAdminManifestRoute, sendData, sendError, sendZodError } from "@kokoro/platform-kit";
import type { FastifyInstance, FastifyReply } from "fastify";
import { ZodError } from "zod";
import type { ModelBindingStatus, ProviderAccountStatus } from "../../domain/model.js";
import type { ModelRepository } from "../../domain/repository.js";
import { modelAdminManifest } from "../admin/manifest.js";
import { upsertSiteModelPolicyRequestSchema } from "./schemas.js";

interface IdParams {
  id: string;
}

export function registerModelAdminRoutes(app: FastifyInstance, repository: ModelRepository): void {
  registerAdminManifestRoute(app, modelAdminManifest);

  app.get("/admin/models/provider-accounts", async (_request, reply) =>
    sendData(reply, await repository.listProviderAccounts()),
  );

  app.get("/admin/models/bindings", async (_request, reply) =>
    sendData(reply, await repository.listAllModelBindings()),
  );

  app.get("/admin/models/labels", async (_request, reply) =>
    sendData(reply, await repository.listModelLabels()),
  );

  app.get<{ Querystring: { siteId?: string } }>(
    "/admin/models/site-policies",
    async (request, reply) =>
      sendData(reply, await repository.listSiteModelPolicies(request.query.siteId)),
  );

  app.post("/admin/models/site-policies", async (request, reply) => {
    try {
      const input = upsertSiteModelPolicyRequestSchema.parse(request.body);
      return sendData(reply, await repository.upsertSiteModelPolicy(input));
    } catch (error) {
      if (error instanceof ZodError) {
        return sendZodError(reply, error);
      }
      return sendError(reply, 500, "model.site_policy_upsert_failed", "站点模型策略写入失败");
    }
  });

  registerProviderAccountStatusRoute(app, repository, "disable", "disabled");
  registerProviderAccountStatusRoute(app, repository, "enable", "active");
  registerModelBindingStatusRoute(app, repository, "disable", "disabled");
  registerModelBindingStatusRoute(app, repository, "enable", "active");
}

function registerProviderAccountStatusRoute(
  app: FastifyInstance,
  repository: ModelRepository,
  action: "disable" | "enable",
  status: ProviderAccountStatus,
): void {
  app.post<{ Params: IdParams }>(
    `/admin/models/provider-accounts/:id/${action}`,
    async (request, reply) => {
      const account = await repository.setProviderAccountStatus(request.params.id, status);
      if (account === null) {
        return sendProviderAccountNotFound(reply);
      }
      return sendData(reply, account);
    },
  );
}

function registerModelBindingStatusRoute(
  app: FastifyInstance,
  repository: ModelRepository,
  action: "disable" | "enable",
  status: ModelBindingStatus,
): void {
  app.post<{ Params: IdParams }>(
    `/admin/models/bindings/:id/${action}`,
    async (request, reply) => {
      const binding = await repository.setModelBindingStatus(request.params.id, status);
      if (binding === null) {
        return sendModelBindingNotFound(reply);
      }
      return sendData(reply, binding);
    },
  );
}

function sendProviderAccountNotFound(reply: FastifyReply) {
  return sendError(reply, 404, "model.provider_account_not_found", "Provider 账号不存在");
}

function sendModelBindingNotFound(reply: FastifyReply) {
  return sendError(reply, 404, "model.binding_not_found", "模型绑定不存在");
}
