// 只读积分包目录 seed 入口（`pnpm run seed:packs`）：任何环境跑同一入口取一致目录。
//
// 为什么需要：不同 Site 仍需一份稳定套餐目录，供展示与卡密权益映射；本脚本不创建订单或发放积分。
// PRD §2 量折扣（¥0.01/积分，大包更省；1 积分=10000 micros）。billingInterval=once。
import { createPrismaClient } from "../../infrastructure/prisma/prisma-client.js";
import { PrismaPaymentRepository } from "../../infrastructure/prisma/prisma-payment-repository.js";

const siteId = process.env.KOKORO_SITE_ID ?? "site-dev";

const PACKS = [
  { key: "pack-100", name: "入门包 100 积分", amountMinor: "100", creditMicros: "1000000" },
  { key: "pack-500", name: "标准包 500 积分", amountMinor: "450", creditMicros: "5000000" },
  { key: "pack-1000", name: "超值包 1000 积分", amountMinor: "850", creditMicros: "10000000" },
  { key: "pack-3000", name: "尊享包 3000 积分", amountMinor: "2400", creditMicros: "30000000" },
];

const prisma = createPrismaClient();
try {
  // 直接用仓库层 upsert（幂等，按 (siteId,key)/key 复调刷新，不重复）——无需 PaymentService 的 credit 授信回调。
  const repo = new PrismaPaymentRepository(prisma);
  for (const p of PACKS) {
    await repo.upsertPlan({ siteId, currency: "CNY", billingInterval: "once", ...p });
    console.log(`[seed:packs] plan ${p.key} (${p.creditMicros}micros / ${p.amountMinor}分)`);
  }
  console.log(`[seed:packs] read-only catalogue ok (site=${siteId})`);
} finally {
  await prisma.$disconnect();
}
