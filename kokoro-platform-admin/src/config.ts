import { z } from "zod";
import type { AuthConfig } from "./auth.js";

// 不 .strict()：parse process.env 超集，strict 会被 PATH/HOME 等无关变量拒绝。
// 默认用稳定服务名(docker/k8s 内部 DNS)，本地开发经 env 覆盖；业务代码不写死 localhost。
const envSchema = z.object({
  KOKORO_ADMIN_PORT: z.coerce.number().int().min(1).max(65535).default(4290),
  DATABASE_URL_ADMIN: z.string().min(1),
  // 大额发积分审批阈值(micros)；超过即需二次审批。默认 100 积分。
  KOKORO_APPROVAL_GRANT_THRESHOLD_MICROS: z.string().regex(/^\d+$/).default("100000000"),
  // 认证：proxy(生产,BFF 注入 x-kokoro-operator + 校 secret)/oidc(验 JWT,对接真 IdP)/dev(本地头,回退默认账号)。
  KOKORO_ADMIN_AUTH_MODE: z.enum(["proxy", "oidc", "dev"]).default("oidc"),
  KOKORO_ADMIN_OIDC_JWKS_URL: z.string().url().optional(),
  KOKORO_ADMIN_OIDC_ISSUER: z.string().min(1).optional(),
  KOKORO_ADMIN_OIDC_AUDIENCE: z.string().min(1).optional(),
  KOKORO_ADMIN_OIDC_EMAIL_CLAIM: z.string().min(1).default("email"),
  KOKORO_ADMIN_DEV_OPERATOR: z.string().min(1).default("admin@kokoro.local"),
  // BFF↔网关内部代理密钥，逗号分隔支持轮换（proxy 模式校验）。
  KOKORO_ADMIN_PROXY_SECRETS: z.string().default(""),
  // admin 网关出站身份凭据：转发到模块时带 x-kokoro-service:admin + 此 secret，模块 route-access 校验 admin 等级。
  KOKORO_INTERNAL_SECRET_ADMIN: z.string().default(""),
  KOKORO_SITE_BASE_URL: z.string().url().default("http://kokoro-site:4201"),
  KOKORO_USER_BASE_URL: z.string().url().default("http://kokoro-user:4211"),
  KOKORO_MODEL_BASE_URL: z.string().url().default("http://kokoro-model:4221"),
  KOKORO_CREDIT_BASE_URL: z.string().url().default("http://kokoro-credit:4231"),
  KOKORO_PAYMENT_BASE_URL: z.string().url().default("http://kokoro-payment:4241"),
  KOKORO_HUB_BASE_URL: z.string().url().default("http://kokoro-hub:4251"),
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
  // 网关出站身份凭据（KOKORO_INTERNAL_SECRET_ADMIN）：转发/拉 manifest/查资源时带 x-kokoro-service:admin + 此 secret。
  internalSecret: string;
  approvalGrantThresholdMicros: bigint;
  auth: AuthConfig;
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
    { id: "hub", label: "Hub", baseUrl: parsed.KOKORO_HUB_BASE_URL, manifestPath: "/hub/admin/manifest" },
  ];

  return {
    adminPort: parsed.KOKORO_ADMIN_PORT,
    adminDbUrl: parsed.DATABASE_URL_ADMIN,
    internalSecret: parsed.KOKORO_INTERNAL_SECRET_ADMIN,
    approvalGrantThresholdMicros: BigInt(parsed.KOKORO_APPROVAL_GRANT_THRESHOLD_MICROS),
    auth: {
      mode: parsed.KOKORO_ADMIN_AUTH_MODE,
      jwksUrl: parsed.KOKORO_ADMIN_OIDC_JWKS_URL,
      issuer: parsed.KOKORO_ADMIN_OIDC_ISSUER,
      audience: parsed.KOKORO_ADMIN_OIDC_AUDIENCE,
      emailClaim: parsed.KOKORO_ADMIN_OIDC_EMAIL_CLAIM,
      devOperator: parsed.KOKORO_ADMIN_DEV_OPERATOR,
      proxySecrets: parsed.KOKORO_ADMIN_PROXY_SECRETS.split(",")
        .map((secret) => secret.trim())
        .filter((secret) => secret.length > 0),
    },
    modules,
  };
}
