import {
  jsonSchema,
  readRequestContext,
  registerHealthRoute,
  sendData,
  sendError,
  sendZodError,
} from "@kokoro/platform-kit";
import type { FastifyInstance, FastifyReply } from "fastify";
import { ZodError } from "zod";
import type { ModelService } from "../../application/model-service.js";
import { isModelLifecycleError } from "../../domain/model-lifecycle.js";
import {
  deleteRequestSchema,
  ensureModelBindingRequestSchema,
  ensureModelLabelRequestSchema,
  ensureProviderAccountRequestSchema,
  listModelBindingsQuerySchema,
  modelBindingParamsSchema,
  providerAccountParamsSchema,
  resolveModelBindingsQuerySchema,
} from "./schemas.js";

export function registerModelRoutes(app: FastifyInstance, service: ModelService): void {
  registerHealthRoute(app, "model");

  app.post(
    "/provider-accounts/ensure",
    {
      schema: {
        tags: ["model"],
        summary: "确保 provider 账号存在（幂等 upsert）",
        body: jsonSchema(ensureProviderAccountRequestSchema),
      },
    },
    async (request, reply) => {
      try {
        const input = ensureProviderAccountRequestSchema.parse(request.body);
        const result = await service.ensureProviderAccount(input);
        return sendData(reply, result);
      } catch (error) {
        return handleModelError(error, reply, "model.provider_account_ensure_failed");
      }
    },
  );

  app.delete(
    "/provider-accounts/:providerAccountId",
    {
      schema: {
        tags: ["model"],
        summary: "删除 provider 账号",
        params: jsonSchema(providerAccountParamsSchema),
        body: jsonSchema(deleteRequestSchema),
      },
    },
    async (request, reply) => {
      try {
        const { providerAccountId } = providerAccountParamsSchema.parse(request.params);
        const input = deleteRequestSchema.parse(request.body);
        const result = await service.deleteProviderAccount({
          id: providerAccountId,
          deletedBy: input.deletedBy,
          reason: input.reason,
        });
        return sendData(reply, result);
      } catch (error) {
        return handleModelError(error, reply, "model.provider_account_delete_failed");
      }
    },
  );

  app.post(
    "/provider-accounts/:providerAccountId/restore",
    {
      schema: {
        tags: ["model"],
        summary: "恢复 provider 账号",
        params: jsonSchema(providerAccountParamsSchema),
      },
    },
    async (request, reply) => {
      try {
        const { providerAccountId } = providerAccountParamsSchema.parse(request.params);
        const result = await service.restoreProviderAccount({ id: providerAccountId });
        return sendData(reply, result);
      } catch (error) {
        return handleModelError(error, reply, "model.provider_account_restore_failed");
      }
    },
  );

  app.post(
    "/model-bindings/ensure",
    {
      schema: {
        tags: ["model"],
        summary: "确保模型绑定存在（幂等 upsert）",
        body: jsonSchema(ensureModelBindingRequestSchema),
      },
    },
    async (request, reply) => {
      try {
        const input = ensureModelBindingRequestSchema.parse(request.body);
        const result = await service.ensureModelBinding(input);
        return sendData(reply, result);
      } catch (error) {
        return handleModelError(error, reply, "model.binding_ensure_failed");
      }
    },
  );

  app.post(
    "/model-labels/ensure",
    {
      schema: {
        tags: ["model"],
        summary: "确保模型标签存在（用户可选模型目录项，幂等 upsert on key）",
        body: jsonSchema(ensureModelLabelRequestSchema),
      },
    },
    async (request, reply) => {
      try {
        const input = ensureModelLabelRequestSchema.parse(request.body);
        const result = await service.ensureModelLabel(input);
        return sendData(reply, result);
      } catch (error) {
        return handleModelError(error, reply, "model.label_ensure_failed");
      }
    },
  );

  app.delete(
    "/model-bindings/:modelBindingId",
    {
      schema: {
        tags: ["model"],
        summary: "删除模型绑定",
        params: jsonSchema(modelBindingParamsSchema),
        body: jsonSchema(deleteRequestSchema),
      },
    },
    async (request, reply) => {
      try {
        const { modelBindingId } = modelBindingParamsSchema.parse(request.params);
        const input = deleteRequestSchema.parse(request.body);
        const result = await service.deleteModelBinding({
          id: modelBindingId,
          deletedBy: input.deletedBy,
          reason: input.reason,
        });
        return sendData(reply, result);
      } catch (error) {
        return handleModelError(error, reply, "model.binding_delete_failed");
      }
    },
  );

  app.post(
    "/model-bindings/:modelBindingId/restore",
    {
      schema: {
        tags: ["model"],
        summary: "恢复模型绑定",
        params: jsonSchema(modelBindingParamsSchema),
      },
    },
    async (request, reply) => {
      try {
        const { modelBindingId } = modelBindingParamsSchema.parse(request.params);
        const result = await service.restoreModelBinding({ id: modelBindingId });
        return sendData(reply, result);
      } catch (error) {
        return handleModelError(error, reply, "model.binding_restore_failed");
      }
    },
  );

  app.get(
    "/model-bindings",
    {
      schema: {
        tags: ["model"],
        summary: "按 feature/label 列出模型绑定",
      },
    },
    async (request, reply) => {
      try {
        const query = listModelBindingsQuerySchema.parse(request.query);
        const result = await service.listModelBindings(query);
        return sendData(reply, result);
      } catch (error) {
        return handleModelError(error, reply, "model.binding_list_failed");
      }
    },
  );

  app.get(
    "/model-bindings/resolve",
    {
      schema: {
        tags: ["model"],
        summary: "解析 feature/label 到可路由的模型绑定",
      },
    },
    async (request, reply) => {
      try {
        const query = resolveModelBindingsQuerySchema.parse(request.query);
        // siteId 来自 x-kokoro-site-id header（可空）；缺省时不按站过滤。
        const siteId = readRequestContext(request.headers).siteId ?? undefined;
        const result = await service.resolveModelBindings({ ...query, siteId });
        return sendData(reply, result);
      } catch (error) {
        return handleModelError(error, reply, "model.binding_resolve_failed");
      }
    },
  );
}

function handleModelError(error: unknown, reply: FastifyReply, fallbackCode: string) {
  if (error instanceof ZodError) {
    return sendZodError(reply, error);
  }

  if (isModelLifecycleError(error)) {
    return sendError(reply, error.statusCode, error.code, error.message);
  }

  return sendError(reply, 500, fallbackCode, "模型配置操作失败");
}
