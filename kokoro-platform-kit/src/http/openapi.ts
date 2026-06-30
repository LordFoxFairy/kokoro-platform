import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import type { FastifyInstance } from "fastify";
import type { ZodType } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// 注册 OpenAPI + Swagger UI（/docs）。同步排队插件——须在路由注册（建议包进 app.register）之前调用，
// @fastify/swagger 以 fastify-plugin 注入根级 onRoute 钩子，捕获其后加载的所有路由 schema。
export function registerOpenApi(
  app: FastifyInstance,
  options: { title: string; description?: string; version?: string },
): void {
  void app.register(fastifySwagger, {
    openapi: {
      info: {
        title: options.title,
        description: options.description ?? "",
        version: options.version ?? "0.1.0",
      },
    },
  });
  void app.register(fastifySwaggerUi, { routePrefix: "/docs" });
}

// 把 Zod schema 转成内联 JSON Schema，供 Fastify 路由 schema.body/response 使用。
export function jsonSchema(schema: ZodType): Record<string, unknown> {
  return zodToJsonSchema(schema, { $refStrategy: "none", target: "openApi3" }) as Record<string, unknown>;
}
