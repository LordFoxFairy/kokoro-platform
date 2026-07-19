// 默认站点 seed 入口（`pnpm run seed:site`）：连库 → service → 幂等 upsert 平台默认站点为 active。
// 任何环境（dev/prod/…）跑同一入口取得一致的默认站点；编排层不再各自硬编码站点定义。
//
// 为什么需要：下游 credit/payment 记账前会调 site 校验站点 active（enforce 闸）。若默认站点缺失或非
// active，credit hold 返回 409、run 无法派发。本 seed 保证 KOKORO_SITE_ID 指向的站点存在且 active。
//
// id 约定：仓库层用 `site-${key}` 生成站点 id（见 prisma-site-repository）。故从 KOKORO_SITE_ID 去掉
// 前缀 `site-` 反推 key，确保 upsert 出的 id 与消费侧（web 回退 / 账户 siteId）一致。
import { createPrismaClient } from "../infrastructure/prisma/prisma-client.js";
import { PrismaSiteRepository } from "../infrastructure/prisma/prisma-site-repository.js";

const siteId = process.env.KOKORO_SITE_ID ?? "site-dev";
const siteName = process.env.KOKORO_SITE_NAME ?? "Kokoro";
// 仓库层 id = `site-${key}`；从 siteId 反推 key，保证 upsert 结果与消费侧 siteId 一致。
const key = siteId.startsWith("site-") ? siteId.slice("site-".length) : siteId;
const expectedId = `site-${key}`;

if (expectedId !== siteId) {
  // KOKORO_SITE_ID 不符合 `site-<key>` 约定时明确失败，避免 seed 出一个消费侧对不上的站点 id。
  throw new Error(
    `KOKORO_SITE_ID=${siteId} 不符合 'site-<key>' 约定，seed 出的 id 将是 ${expectedId}，与消费侧不一致。`,
  );
}

const prisma = createPrismaClient();
try {
  // 直接用仓库层 upsertSite（幂等，不涉及域名校验，故无需 SiteService 的 DomainVerifier 依赖）。
  const repository = new PrismaSiteRepository(prisma);
  const site = await repository.upsertSite({ key, name: siteName, status: "active" });
  console.log(`[seed:site] ok — id=${site.id} key=${key} status=${site.status}`);
} finally {
  await prisma.$disconnect();
}
