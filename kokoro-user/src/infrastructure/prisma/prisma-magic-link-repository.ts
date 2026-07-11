import type { PrismaClient } from "@prisma/client";
import type {
  IssueMagicLinkInput,
  MagicLinkRecord,
  MagicLinkRepository,
} from "../../domain/magic-link.js";

export class PrismaMagicLinkRepository implements MagicLinkRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async issue(input: IssueMagicLinkInput): Promise<MagicLinkRecord> {
    // 事务内：先把同 (siteId,email) 的存活旧链作废，再落新链——同邮箱同一时刻至多一条可消费链。
    return this.prisma.$transaction(async (tx) => {
      await tx.magicLink.updateMany({
        where: {
          siteId: input.siteId,
          email: input.email,
          consumedAt: null,
          supersededAt: null,
        },
        data: { supersededAt: input.now },
      });
      return tx.magicLink.create({
        data: {
          siteId: input.siteId,
          email: input.email,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
        },
      });
    });
  }

  async consume(tokenHash: string, now: Date): Promise<MagicLinkRecord | null> {
    // 条件转移：updateMany 的 where 即消费前置条件，MySQL 行锁保证并发双花只有一方 count=1。
    const transferred = await this.prisma.magicLink.updateMany({
      where: {
        tokenHash,
        consumedAt: null,
        supersededAt: null,
        expiresAt: { gt: now },
      },
      data: { consumedAt: now },
    });
    if (transferred.count !== 1) {
      return null;
    }
    return this.prisma.magicLink.findUnique({ where: { tokenHash } });
  }
}
