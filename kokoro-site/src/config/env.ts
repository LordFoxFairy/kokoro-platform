import { z } from "zod";

// WHY: env is a superset of process.env; strict would reject PATH/HOME and crash on boot.
export const siteEnvSchema = z.object({
  DATABASE_URL_SITE: z.string().url(),
  KOKORO_SITE_PORT: z.coerce.number().int().min(1).max(65535).default(4201),
  KOKORO_SITE_BASE_URL: z.string().url().default("http://kokoro-site:4201"),
  // @deprecated 遗留单一共享密钥。入站校验已改由 route-access 的 per-caller 注册表
  // （KOKORO_INTERNAL_SECRET_<CALLER>，见 loadCallerSecrets）执行；此字段保留仅为兼容旧部署模板。
  KOKORO_INTERNAL_SECRET: z.string().default(""),
});

export type SiteEnv = z.infer<typeof siteEnvSchema>;

export function loadSiteEnv(env: NodeJS.ProcessEnv = process.env): SiteEnv {
  return siteEnvSchema.parse(env);
}
