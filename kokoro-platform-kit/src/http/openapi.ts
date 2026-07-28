import fastifySwagger from "@fastify/swagger";
import type { FastifyInstance } from "fastify";
import type { ZodType } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// 注册 OpenAPI JSON 契约（/docs/json）。同步排队插件——须在路由注册（建议包进 app.register）之前调用，
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
  void app.register(async (instance) => {
    instance.get(
      "/docs/json",
      { schema: { hide: true } },
      async () => instance.swagger(),
    );
  });
}

// Fastify 校验用 AJV(draft-07)，与 openApi3 方言有两处冲突，统一在此归一：
// ① 删 additionalProperties:false —— 否则 AJV 抢先剥离多余字段，削弱各模块 Zod .strict() 这个唯一闸门；
// ② exclusiveMinimum/Maximum 布尔(draft-4) → 数值(draft-07) —— 否则 AJV 构建校验器时抛错。
// 结果：schema 仅做宽松校验+文档，真正的 strict 仍由模块 Zod .parse 把关。
function toAjvSafe(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(toAjvSafe);
  }
  if (node === null || typeof node !== "object") {
    return node;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    out[key] = toAjvSafe(value);
  }
  if (out.additionalProperties === false) {
    delete out.additionalProperties;
  }
  if (out.exclusiveMinimum === true && typeof out.minimum === "number") {
    out.exclusiveMinimum = out.minimum;
    delete out.minimum;
  } else if (typeof out.exclusiveMinimum === "boolean") {
    delete out.exclusiveMinimum;
  }
  if (out.exclusiveMaximum === true && typeof out.maximum === "number") {
    out.exclusiveMaximum = out.maximum;
    delete out.maximum;
  } else if (typeof out.exclusiveMaximum === "boolean") {
    delete out.exclusiveMaximum;
  }
  return out;
}

// 把 Zod schema 转成 Fastify(AJV) 安全的内联 JSON Schema，供路由 schema.body 使用。
export function jsonSchema(schema: ZodType): Record<string, unknown> {
  return toAjvSafe(zodToJsonSchema(schema, { $refStrategy: "none", target: "openApi3" })) as Record<string, unknown>;
}
