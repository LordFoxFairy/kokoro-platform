import { z } from "zod";
import { magicLinkDeliveryModes } from "../domain/magic-link.js";

// 不 .strict()：parse process.env 超集，strict 会被 PATH/HOME 等无关变量拒绝
export const userEnvSchema = z.object({
  DATABASE_URL_USER: z.string().url(),
  KOKORO_USER_PORT: z.coerce.number().int().min(1).max(65535).default(4211),
  KOKORO_USER_BASE_URL: z.string().url().default("http://kokoro-user:4211"),
  KOKORO_CREDIT_BASE_URL: z.string().url().default("http://kokoro-credit:4231"),
  KOKORO_PAYMENT_BASE_URL: z.string().url().default("http://kokoro-payment:4241"),
  // 终端用户会话签发密钥（HS256）：与 kokoro-session 同名同值部署，session 验签共享。
  // 生产禁用（未配私钥即 fail-fast，见 resolveUserSigning）；仅 dev/test 退化档。
  // 未配置且无私钥（非生产）= /auth/sessions fail-closed（503），绝不签发未签名 token。
  KOKORO_AUTH_JWT_SECRET: z.string().min(1).optional(),
  // RS256 签发私钥（PEM/PKCS8）：生产签发链正解。配置即以 RS256 签发，kid=公钥 SPKI 指纹前 16hex，
  // 经 GET /.well-known/jwks.json 暴露公钥供 session 验签。生产必配，否则启动 fail-fast。
  KOKORO_USER_JWT_PRIVATE_KEY: z.string().min(1).optional(),
  // 轮换用上一把私钥（PEM/PKCS8，可选）：其公钥一并进 JWKS，令旧 kid 的在飞 token 平滑过渡。
  KOKORO_USER_JWT_PRIVATE_KEY_PREVIOUS: z.string().min(1).optional(),
  // magic-link 限频后端：配置即用 Redis 固定窗口计数（多副本一致），Redis 不可达 fail-open 放行+WARN；
  // 未配置=进程内存计数（单副本 dev）。
  KOKORO_REDIS_URL: z.string().min(1).optional(),
  KOKORO_AUTH_JWT_TTL_SECONDS: z.coerce.number().int().min(60).max(86400).default(3600),
  KOKORO_AUTH_JWT_ISSUER: z.string().min(1).default("kokoro-user"),
  // magic-link 一次性 token 存活时长。
  KOKORO_AUTH_MAGIC_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  // 投递档：response=token 回响应体（仅 dev；生产 fail-fast 禁用）、log=只写日志哈希前缀（缺省）、
  // smtp=经 SMTP 发登录邮件（生产档，须配下方 SMTP_* 与 MAGIC_LINK_BASE_URL）。
  KOKORO_AUTH_MAGIC_DELIVERY: z.enum(magicLinkDeliveryModes).default("log"),
  // 登录链基址（smtp 档必配）：邮件里的可点链 = <此值>?token=<原文 token>。
  // 通常指向 web 回调端点，如 https://your-domain/api/auth/callback。
  KOKORO_AUTH_MAGIC_LINK_BASE_URL: z.string().url().optional(),
  // SMTP 投递（smtp 档必配 HOST/FROM；AUTH 视服务器要求）。465=隐式 TLS,其余 STARTTLS。
  KOKORO_SMTP_HOST: z.string().min(1).optional(),
  KOKORO_SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  KOKORO_SMTP_USER: z.string().min(1).optional(),
  KOKORO_SMTP_PASSWORD: z.string().min(1).optional(),
  KOKORO_SMTP_FROM: z.string().min(1).optional(),
  // email+ip 两维固定窗口限频。RATE_MAX=单邮箱阈值；RATE_IP_MAX=单 IP 阈值（缺省 = RATE_MAX*10，
  // IP 合法服务多用户须远宽于单邮箱）。配 KOKORO_REDIS_URL 即多副本一致，否则进程内存。
  KOKORO_AUTH_MAGIC_RATE_MAX: z.coerce.number().int().min(1).default(5),
  KOKORO_AUTH_MAGIC_RATE_IP_MAX: z.coerce.number().int().min(1).optional(),
  KOKORO_AUTH_MAGIC_RATE_WINDOW_SECONDS: z.coerce.number().int().min(60).default(900),
  // 团队邀请存活时长；缺省 7 天。
  KOKORO_TEAM_INVITE_TTL_SECONDS: z.coerce.number().int().min(300).max(2592000).default(604800),
  // 长效 refresh token 存活时长；缺省 30 天（下限 1 小时，上限 90 天）。持久层只存 SHA-256 哈希，可吊销可轮换。
  KOKORO_AUTH_REFRESH_TTL_SECONDS: z.coerce.number().int().min(3600).max(7776000).default(2592000),
});

export type UserEnv = z.infer<typeof userEnvSchema>;

export function loadUserEnv(env: NodeJS.ProcessEnv = process.env): UserEnv {
  return userEnvSchema.parse(env);
}
