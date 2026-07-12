import { z } from "zod";
import { magicLinkDeliveryModes } from "../domain/magic-link.js";

// 不 .strict()：parse process.env 超集，strict 会被 PATH/HOME 等无关变量拒绝
export const userEnvSchema = z.object({
  DATABASE_URL_USER: z.string().url(),
  KOKORO_USER_PORT: z.coerce.number().int().min(1).max(65535).default(4211),
  KOKORO_USER_BASE_URL: z.string().url().default("http://kokoro-user:4211"),
  // @deprecated 遗留单一共享密钥。入站校验已改由 route-access 的 per-caller 注册表
  // （KOKORO_INTERNAL_SECRET_<CALLER>，见 loadCallerSecrets）执行；保留仅为兼容旧部署模板。
  KOKORO_INTERNAL_SECRET: z.string().default(""),
  KOKORO_MODEL_BASE_URL: z.string().url().default("http://kokoro-model:4221"),
  KOKORO_CREDIT_BASE_URL: z.string().url().default("http://kokoro-credit:4231"),
  KOKORO_PAYMENT_BASE_URL: z.string().url().default("http://kokoro-payment:4241"),
  // 终端用户会话签发密钥（HS256）：与 kokoro-session 同名同值部署，session 验签共享。
  // 未配置 = /auth/sessions fail-closed（503），绝不签发未签名 token；其它路由不受影响。
  KOKORO_AUTH_JWT_SECRET: z.string().min(1).optional(),
  KOKORO_AUTH_JWT_TTL_SECONDS: z.coerce.number().int().min(60).max(86400).default(3600),
  KOKORO_AUTH_JWT_ISSUER: z.string().min(1).default("kokoro-user"),
  // magic-link 一次性 token 存活时长。
  KOKORO_AUTH_MAGIC_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  // V1 dev 投递档：response=token 回响应体（仅限 dev 部署），log=只写服务日志不回体（缺省，最安全档）。
  // 邮件投递接口留位：SMTP/供应商接入时新增档位替换 log 落点，此处不臆造 SMTP 配置。
  KOKORO_AUTH_MAGIC_DELIVERY: z.enum(magicLinkDeliveryModes).default("log"),
  // 同邮箱固定窗口限频（进程内存计数；生产多副本应换 redis）。
  KOKORO_AUTH_MAGIC_RATE_MAX: z.coerce.number().int().min(1).default(5),
  KOKORO_AUTH_MAGIC_RATE_WINDOW_SECONDS: z.coerce.number().int().min(60).default(900),
});

export type UserEnv = z.infer<typeof userEnvSchema>;

export function loadUserEnv(env: NodeJS.ProcessEnv = process.env): UserEnv {
  return userEnvSchema.parse(env);
}
