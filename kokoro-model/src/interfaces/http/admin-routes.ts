import { registerAdminManifestRoute, sendData, sendError, sendZodError } from "@kokoro/platform-kit";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z, ZodError } from "zod";
import type { ModelBindingStatus, ProviderAccountStatus } from "../../domain/model.js";
import { isModelLifecycleError } from "../../domain/model-lifecycle.js";
import type { ModelRepository } from "../../domain/repository.js";
import { modelAdminManifest } from "../admin/manifest.js";
import {
  deleteRequestSchema,
  modelBindingParamsSchema,
  providerAccountParamsSchema,
  upsertSiteModelPolicyRequestSchema,
} from "./schemas.js";

interface IdParams {
  id: string;
}

export function registerModelAdminRoutes(app: FastifyInstance, repository: ModelRepository): void {
  registerAdminManifestRoute(app, modelAdminManifest);

  app.get("/admin/models/provider-accounts", async (request, reply) => {
    const query = globalAdminListQuerySchema.safeParse(request.query);
    if (!query.success) return sendZodError(reply, query.error);
    return sendData(reply, await repository.listProviderAccounts({ includeDeleted: true }));
  });

  app.get("/admin/models/bindings", async (request, reply) => {
    const query = globalAdminListQuerySchema.safeParse(request.query);
    if (!query.success) return sendZodError(reply, query.error);
    return sendData(reply, await repository.listAllModelBindings({ includeDeleted: true }));
  });

  app.get("/admin/models/labels", async (request, reply) => {
    const query = globalAdminListQuerySchema.safeParse(request.query);
    if (!query.success) return sendZodError(reply, query.error);
    return sendData(reply, await repository.listModelLabels());
  });

  app.get<{ Querystring: { siteId?: string } }>(
    "/admin/models/site-policies",
    async (request, reply) => {
      const query = adminSiteListQuerySchema.safeParse(request.query);
      if (!query.success) return sendZodError(reply, query.error);
      return sendData(reply, await repository.listSiteModelPolicies(query.data.siteId));
    },
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
  registerProviderAccountLifecycleRoutes(app, repository);
  registerModelBindingStatusRoute(app, repository, "disable", "disabled");
  registerModelBindingStatusRoute(app, repository, "enable", "active");
  registerModelBindingLifecycleRoutes(app, repository);
}

const adminSiteListQuerySchema = z.object({ siteId: z.string().trim().min(1).optional() }).strict();
const globalAdminListQuerySchema = z.object({}).strict();

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

function registerProviderAccountLifecycleRoutes(app: FastifyInstance, repository: ModelRepository): void {
  app.delete("/admin/models/provider-accounts/:providerAccountId", async (request, reply) => {
    try {
      const { providerAccountId } = providerAccountParamsSchema.parse(request.params);
      const input = deleteRequestSchema.parse(request.body);
      const result = await repository.deleteProviderAccount({
        id: providerAccountId,
        deletedBy: input.deletedBy,
        reason: input.reason,
      });
      return sendData(reply, result);
    } catch (error) {
      return handleAdminModelError(error, reply, "model.provider_account_delete_failed");
    }
  });

  app.post("/admin/models/provider-accounts/:providerAccountId/restore", async (request, reply) => {
    try {
      const { providerAccountId } = providerAccountParamsSchema.parse(request.params);
      const result = await repository.restoreProviderAccount({ id: providerAccountId });
      return sendData(reply, result);
    } catch (error) {
      return handleAdminModelError(error, reply, "model.provider_account_restore_failed");
    }
  });
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

function registerModelBindingLifecycleRoutes(app: FastifyInstance, repository: ModelRepository): void {
  app.delete("/admin/models/bindings/:modelBindingId", async (request, reply) => {
    try {
      const { modelBindingId } = modelBindingParamsSchema.parse(request.params);
      const input = deleteRequestSchema.parse(request.body);
      const result = await repository.deleteModelBinding({
        id: modelBindingId,
        deletedBy: input.deletedBy,
        reason: input.reason,
      });
      return sendData(reply, result);
    } catch (error) {
      return handleAdminModelError(error, reply, "model.binding_delete_failed");
    }
  });

  app.post("/admin/models/bindings/:modelBindingId/restore", async (request, reply) => {
    try {
      const { modelBindingId } = modelBindingParamsSchema.parse(request.params);
      const result = await repository.restoreModelBinding({ id: modelBindingId });
      return sendData(reply, result);
    } catch (error) {
      return handleAdminModelError(error, reply, "model.binding_restore_failed");
    }
  });
}

function handleAdminModelError(error: unknown, reply: FastifyReply, fallbackCode: string) {
  if (error instanceof ZodError) {
    return sendZodError(reply, error);
  }
  if (isModelLifecycleError(error)) {
    return sendError(reply, error.statusCode, error.code, error.message);
  }
  return sendError(reply, 500, fallbackCode, "模型管理操作失败");
}

function sendProviderAccountNotFound(reply: FastifyReply) {
  return sendError(reply, 404, "model.provider_account_not_found", "Provider 账号不存在");
}

function sendModelBindingNotFound(reply: FastifyReply) {
  return sendError(reply, 404, "model.binding_not_found", "模型绑定不存在");
}
