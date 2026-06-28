import { z } from "zod";

export const siteEnvSchema = z.object({
  DATABASE_URL_SITE: z.string().url(),
  KOKORO_SITE_PORT: z.coerce.number().int().min(1).max(65535).default(4201),
  KOKORO_SITE_BASE_URL: z.string().url().default("http://kokoro-site:4201"),
});

export type SiteEnv = z.infer<typeof siteEnvSchema>;

export function loadSiteEnv(env: NodeJS.ProcessEnv = process.env): SiteEnv {
  return siteEnvSchema.parse(env);
}
