import { registerHealthRoute, sendData, sendError, sendZodError } from "@kokoro/platform-kit";
import type { FastifyInstance, FastifyReply } from "fastify";
import { ZodError } from "zod";
import type { ModelService } from "../../application/model-service.js";
import {
  ensureModelBindingRequestSchema,
  ensureProviderAccountRequestSchema,
  listModelBindingsQuerySchema,
} from "./schemas.js";

export function registerModelRoutes(app: FastifyInstance, service: ModelService): void {
  registerHealthRoute(app, "model");

  app.post("/provider-accounts/ensure", async (request, reply) => {
    try {
      const input = ensureProviderAccountRequestSchema.parse(request.body);
      const result = await service.ensureProviderAccount(input);
      return sendData(reply, result);
    } catch (error) {
      return handleModelError(error, reply, "model.provider_account_ensure_failed");
    }
  });

  app.post("/model-bindings/ensure", async (request, reply) => {
    try {
      const input = ensureModelBindingRequestSchema.parse(request.body);
      const result = await service.ensureModelBinding(input);
      return sendData(reply, result);
    } catch (error) {
      return handleModelError(error, reply, "model.binding_ensure_failed");
    }
  });

  app.get("/model-bindings", async (request, reply) => {
    try {
      const query = listModelBindingsQuerySchema.parse(request.query);
      const result = await service.listModelBindings(query);
      return sendData(reply, result);
    } catch (error) {
      return handleModelError(error, reply, "model.binding_list_failed");
    }
  });
}

function handleModelError(error: unknown, reply: FastifyReply, fallbackCode: string) {
  if (error instanceof ZodError) {
    return sendZodError(reply, error);
  }

  return sendError(reply, 500, fallbackCode, "模型配置操作失败");
}
