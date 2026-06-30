import { z } from "zod";

// 不 .strict()：parse process.env 超集，strict 会被 PATH/HOME 等无关变量拒绝。
// 默认用稳定服务名(docker/k8s 内部 DNS)，本地开发经 env 覆盖；业务代码不写死 localhost。
const envSchema = z.object({
  KOKORO_ADMIN_PORT: z.coerce.number().int().min(1).max(65535).default(4290),
  DATABASE_URL_ADMIN: z.string().min(1),
  // 大额发积分审批阈值(micros)；超过即需二次审批。默认 100 积分。
  KOKORO_APPROVAL_GRANT_THRESHOLD_MICROS: z.string().regex(/^\d+$/).default("100000000"),
  KOKORO_SITE_BASE_URL: z.string().url().default("http://kokoro-site:4201"),
  KOKORO_USER_BASE_URL: z.string().url().default("http://kokoro-user:4211"),
  KOKORO_MODEL_BASE_URL: z.string().url().default("http://kokoro-model:4221"),
  KOKORO_CREDIT_BASE_URL: z.string().url().default("http://kokoro-credit:4231"),
  KOKORO_PAYMENT_BASE_URL: z.string().url().default("http://kokoro-payment:4241"),
});

export type AdminEnv = z.infer<typeof envSchema>;

export interface ModuleConfig {
  id: string;
  label: string;
  baseUrl: string;
  manifestPath: string;
}

export interface AdminConfig {
  adminPort: number;
  adminDbUrl: string;
  approvalGrantThresholdMicros: bigint;
  modules: ModuleConfig[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AdminConfig {
  const parsed = envSchema.parse(env);

  const modules: ModuleConfig[] = [
    { id: "site", label: "Sites", baseUrl: parsed.KOKORO_SITE_BASE_URL, manifestPath: "/admin/sites/manifest" },
    { id: "user", label: "Users", baseUrl: parsed.KOKORO_USER_BASE_URL, manifestPath: "/admin/users/manifest" },
    { id: "model", label: "Models", baseUrl: parsed.KOKORO_MODEL_BASE_URL, manifestPath: "/admin/models/manifest" },
    { id: "credit", label: "Credits", baseUrl: parsed.KOKORO_CREDIT_BASE_URL, manifestPath: "/admin/credits/manifest" },
    { id: "payment", label: "Payments", baseUrl: parsed.KOKORO_PAYMENT_BASE_URL, manifestPath: "/admin/payments/manifest" },
  ];

  return {
    adminPort: parsed.KOKORO_ADMIN_PORT,
    adminDbUrl: parsed.DATABASE_URL_ADMIN,
    approvalGrantThresholdMicros: BigInt(parsed.KOKORO_APPROVAL_GRANT_THRESHOLD_MICROS),
    modules,
  };
}
