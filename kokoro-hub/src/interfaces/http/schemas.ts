import { z } from "zod";
import { REVIEW_STATUSES } from "../../contract/skill-curation-storage.js";

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

// base64 zip 上传体（JSON 档；multipart 档在路由层解析后归一到同一形状）。
// names 只在 confirm 使用：null/缺省 = 发布 zip 内全部候选。
const base64Re = /^[A-Za-z0-9+/]+={0,2}$/;

export const uploadJsonBodySchema = z
  .object({
    namespace: z.string().trim().min(1),
    zip_base64: z
      .string()
      .min(1)
      .refine((value) => value.length % 4 === 0 && base64Re.test(value), {
        message: "zip_base64 must be valid base64",
      }),
    names: z.array(z.string().trim().min(1)).min(1).optional(),
  })
  .strict();

// multipart 档的文本字段（file part 之外）：names 传 JSON 数组字符串。
export const uploadMultipartFieldsSchema = z
  .object({
    namespace: z.string().trim().min(1),
    names: z.array(z.string().trim().min(1)).min(1).optional(),
  })
  .strict();

// self 面上传（HUB-AUTHZ）：scope 恒取自信封头，body 不收 namespace（strict → 收到即 400 伪造）。
export const selfUploadJsonBodySchema = z
  .object({
    zip_base64: z
      .string()
      .min(1)
      .refine((value) => value.length % 4 === 0 && base64Re.test(value), {
        message: "zip_base64 must be valid base64",
      }),
    names: z.array(z.string().trim().min(1)).min(1).optional(),
  })
  .strict();

// self multipart 文本字段：只允许 names（namespace/scope 由 strict 拒绝，防信封外伪造 scope）。
export const selfUploadMultipartFieldsSchema = z
  .object({
    names: z.array(z.string().trim().min(1)).min(1).optional(),
  })
  .strict();

// 运营位（HUB-4）：三个位都可选但至少一个（空更新 400）；category 传 null = 清除分类。
export const curationBodySchema = z
  .object({
    display_weight: z.number().int().optional(),
    pinned: z.boolean().optional(),
    category: z.string().trim().min(1).nullable().optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.display_weight !== undefined || body.pinned !== undefined || body.category !== undefined,
    { message: "at least one of display_weight/pinned/category is required" },
  );

// 审核状态机（HUB-4）：三态；V1 上传自动 approved，本 API 为后续人审留位。
export const reviewBodySchema = z
  .object({
    status: z.enum(REVIEW_STATUSES),
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
