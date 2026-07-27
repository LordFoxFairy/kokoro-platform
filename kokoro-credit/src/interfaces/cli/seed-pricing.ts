// 平台内置默认计价 seed 入口（`pnpm run seed:pricing`）：任何环境跑同一入口取一致计价，编排层不再硬编码。
//
// 为什么需要：run 受理冻结按 pricing × 预估用量算冻结额；缺计价规则则 run 无法正确计价。
// PRD 2026-07-17-credit-pricing-strategy §7 内置默认档：chat input 40 / output 120 micros/token。
// 1 积分=10000 micros；典型 500+500 token 对话 ≈ (500×40+500×120)/10000 = 8 积分。
import { createPrismaClient } from "../../infrastructure/prisma/prisma-client.js";
import { PrismaCreditRepository } from "../../infrastructure/prisma/prisma-credit-repository.js";

const DEFAULT_PRICING = [
  { featureKey: "chat", unit: "input_token", amountMicros: "40" },
  { featureKey: "chat", unit: "output_token", amountMicros: "120" },
];

const prisma = createPrismaClient();
try {
  const repo = new PrismaCreditRepository(prisma);
  for (const rule of DEFAULT_PRICING) {
    // 幂等：PricingRule 无唯一键，先查 (featureKey, unit, labelKey=null, 未删) 存在则跳过，避免重复行。
    const existing = await prisma.pricingRule.findFirst({
      where: { featureKey: rule.featureKey, unit: rule.unit, labelKey: null, deletedAt: null },
    });
    if (existing) {
      console.log(`[seed:pricing] skip ${rule.featureKey}/${rule.unit} (exists)`);
      continue;
    }
    await repo.createPricingRule(rule);
    console.log(`[seed:pricing] ok ${rule.featureKey}/${rule.unit}=${rule.amountMicros}micros`);
  }
} finally {
  await prisma.$disconnect();
}
