import {
  jsonSchema,
  readRequestContext,
  registerHealthRoute,
  registerMetricsRoute,
  sendData,
  sendError,
  sendZodError,
} from "@kokoro/platform-kit";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import type { ModelService } from "../../application/model-service.js";
import { isModelLifecycleError } from "../../domain/model-lifecycle.js";
import {
  deleteRequestSchema,
  ensureModelBindingRequestSchema,
  ensureModelLabelRequestSchema,
  ensureProviderAccountRequestSchema,
  listModelBindingsQuerySchema,
  listModelLabelsQuerySchema,
  modelBindingParamsSchema,
  providerAccountParamsSchema,
  resolveModelBindingsQuerySchema,
} from "./schemas.js";

// resolve 的站点归属以 query 的 siteId 为权威来源：它是契约里的必填参数，缺失即被 schema 拒绝，
// 因此不存在「无站点上下文」的 resolve。header 只是调用方对自身 site 的裸断言，不足以承担隔离边界——
// 曾经从 header 取值且允许为空，效果是调用方不发 header 就能绕过该站的模型隐藏策略（fail-open）。
// header 若同时存在则只做交叉校验：与 query 不一致意味着调用方身份混淆（confused deputy），
// 两边都不可信，硬拒而非挑一个信。header 缺失不构成拒绝理由——query 已给出权威归属。
// 400 而非 403：这是请求自身自相矛盾，不是站点授权判定，也不向调用方泄漏我们认可哪一侧。
// 与 credit 的 rejectSiteMismatch 保持同一处理方式，只是权威侧是 query 而非 body。
function rejectSiteMismatch(
  request: FastifyRequest,
  reply: FastifyReply,
  querySiteId: string,
): FastifyReply | undefined {
  const ctx = readRequestContext(request.headers);
  if (ctx.siteId !== null && ctx.siteId !== querySiteId) {
    return sendError(
      reply,
      400,
      "model.site_mismatch",
      "站点上下文与请求参数不一致",
      undefined,
      ctx.requestId,
    );
  }
  return undefined;
}

export function registerModelRoutes(app: FastifyInstance, service: ModelService): void {
  registerHealthRoute(app, "model");
  registerMetricsRoute(app, "model");

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

  app.get(
    "/model-labels",
    {
      schema: {
        tags: ["model"],
        summary: "列出用户可选模型目录（运行时消费，只出 active，可按 featureKey 过滤）",
        querystring: jsonSchema(listModelLabelsQuerySchema),
      },
    },
    async (request, reply) => {
      try {
        const query = listModelLabelsQuerySchema.parse(request.query);
        const labels = await service.listActiveModelLabels(query.featureKey);
        return sendData(reply, labels);
      } catch (error) {
        return handleModelError(error, reply, "model.label_list_failed");
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
        summary: "解析 feature/label 到可路由的模型绑定（siteId 必填，应用该站隐藏策略）",
      },
    },
    async (request, reply) => {
      try {
        // 先 parse：siteId 是必填 query 参数，缺失在这里就被 schema 拒成 400。
        const query = resolveModelBindingsQuerySchema.parse(request.query);
        const mismatch = rejectSiteMismatch(request, reply, query.siteId);
        if (mismatch) {
          return mismatch;
        }
        const result = await service.resolveModelBindings(query);
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
