import { z } from "zod";

// node 侧 env 单一契约：模块加载即校验，缺关键项 fail-fast，不拖到运行时神秘报错。
// 仅 node 运行时导入（auth.ts / email.ts）；edge middleware 另行直读 process.env。
// SMTP 全可选：未配则 email.ts 退回 console。生产是否强制 SMTP 属部署编排关注，不在构建期硬卡。
const optionalString = z.preprocess((value) => (value === "" ? undefined : value), z.string().optional());
const optionalPort = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.coerce.number().int().positive().optional(),
);

const schema = z.object({
  AUTH_SECRET: z.string().min(1),
  DATABASE_URL_ADMIN: z.string().min(1),
  KOKORO_GATEWAY_URL: z.string().url(),
  KOKORO_ADMIN_PROXY_SECRET: z.string().min(1),
  MAGIC_LINK_MAX_AGE: z.coerce.number().int().positive().default(600),
  EMAIL_FROM: z.string().min(1).default("no-reply@kokoro.local"),
  EMAIL_SERVER_HOST: optionalString,
  EMAIL_SERVER_PORT: optionalPort,
  EMAIL_SERVER_USER: optionalString,
  EMAIL_SERVER_PASSWORD: optionalString,
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type AdminWebEnv = z.infer<typeof schema>;

export function parseEnv(source: Record<string, string | undefined>): AdminWebEnv {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`[env] admin-web 配置校验失败：\n${lines}`);
  }
  return parsed.data;
}

export function assertSmtpConfigured(value: AdminWebEnv): void {
  if (value.NODE_ENV !== "production") return;
  const missing = [
    value.EMAIL_SERVER_HOST ? null : "EMAIL_SERVER_HOST",
    value.EMAIL_SERVER_PORT === undefined ? "EMAIL_SERVER_PORT" : null,
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`[env] production SMTP 配置缺失：${missing.join(", ")}`);
  }
}

export const env = parseEnv(process.env);
