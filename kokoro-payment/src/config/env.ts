import { z } from "zod";
import type { PaymentProviderKind } from "../domain/provider.js";

const REAL_PROVIDER_KINDS: readonly PaymentProviderKind[] = ["stripe", "alipay", "wechat"];

// 部署启用清单：逗号分隔的真实渠道 kind。未列出的 kind 走注册表 501（fail-loud，不假绿）。
// 空/缺省=只 mock。非法 kind 直接抛错，避免拼写错误被静默吞掉。
export function parseEnabledProviders(raw: string): PaymentProviderKind[] {
  const kinds: PaymentProviderKind[] = [];
  for (const token of raw.split(",")) {
    const kind = token.trim();
    if (kind === "") {
      continue;
    }
    if (!REAL_PROVIDER_KINDS.includes(kind as PaymentProviderKind)) {
      throw new Error(`unknown payment provider kind in KOKORO_PAYMENT_ENABLED_PROVIDERS: ${kind}`);
    }
    kinds.push(kind as PaymentProviderKind);
  }
  return kinds;
}

// WHY: 解析 process.env 超集，故意保留 strip；strict 会被 PATH/HOME 等无关变量拒绝。
export const paymentEnvSchema = z.object({
  DATABASE_URL_PAYMENT: z.string().url(),
  KOKORO_PAYMENT_PORT: z.coerce.number().int().min(1).max(65535).default(4241),
  // 启用真实 webhook 验签的渠道清单（逗号分隔，如 "stripe,alipay"）；未列出者恒 501。
  KOKORO_PAYMENT_ENABLED_PROVIDERS: z.string().default(""),
  // confirming 悬挂收尾:sweep 周期(0=关)与判定阈值(updatedAt 早于此秒数才算悬挂,避开正常确认在途窗口)。
  KOKORO_PAYMENT_CONFIRM_SWEEP_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(300),
  KOKORO_PAYMENT_CONFIRM_STALE_SECONDS: z.coerce.number().int().min(1).default(120),
  KOKORO_USER_BASE_URL: z.string().url().default("http://kokoro-user:4211"),
  KOKORO_MODEL_BASE_URL: z.string().url().default("http://kokoro-model:4221"),
  KOKORO_CREDIT_BASE_URL: z.string().url().default("http://kokoro-credit:4231"),
  KOKORO_PAYMENT_BASE_URL: z.string().url().default("http://kokoro-payment:4241"),
});

export type PaymentEnv = z.infer<typeof paymentEnvSchema>;

export function loadPaymentEnv(env: NodeJS.ProcessEnv = process.env): PaymentEnv {
  return paymentEnvSchema.parse(env);
}
