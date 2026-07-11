import { z } from "zod";

// namespace 是不透明运行时隔离键（GA/agent 口径），hub 只做非空校验，不解析身份语义。
export const namespaceQuerySchema = z
  .object({
    namespace: z.string().trim().min(1),
  })
  .strict();

export const scopeNameParamsSchema = z
  .object({
    scope: z.string().trim().min(1),
    name: z.string().trim().min(1),
  })
  .strict();

export const nameParamsSchema = z
  .object({
    name: z.string().trim().min(1),
  })
  .strict();

export const enableBodySchema = z
  .object({
    namespace: z.string().trim().min(1),
  })
  .strict();

// 至少一个位存在，否则是无意义空更新（400）；两个位都可选，互不依赖。
export const officialFlagsBodySchema = z
  .object({
    enabled: z.boolean().optional(),
    required: z.boolean().optional(),
  })
  .strict()
  .refine((body) => body.enabled !== undefined || body.required !== undefined, {
    message: "at least one of enabled/required is required",
  });
