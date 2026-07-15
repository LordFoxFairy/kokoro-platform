import type { PrismaClient } from "@prisma/client";
import type {
  IssueRefreshTokenInput,
  RefreshTokenRecord,
  RefreshTokenRepository,
} from "../../domain/refresh-token.js";

// 轮换重放宽限窗（毫秒）：刚被合法轮换的 refresh 在此窗内被并发再次出示，判为「多 tab 正常并发」
// 而非泄露重放——不吊销整链（否则会把开多 tab 的正常用户误踢下线），仅本次消费失败返 null。
// 超出此窗仍出示已消费的 refresh = 疑似令牌泄露重放，吊销整链兜底。
const REFRESH_REPLAY_GRACE_MS = 60_000;

export class PrismaRefreshTokenRepository implements RefreshTokenRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async issue(input: IssueRefreshTokenInput): Promise<RefreshTokenRecord> {
    return this.prisma.refreshToken.create({
      data: {
        namespace: input.namespace,
        siteId: input.siteId,
        tokenHash: input.tokenHash,
        tokenPrefix: input.tokenPrefix,
        expiresAt: input.expiresAt,
      },
    });
  }

  async consume(tokenHash: string, now: Date): Promise<RefreshTokenRecord | null> {
    // 事务内条件转移 + 重放检测原子成一体，读到的已消费态与吊销决策一致。
    return this.prisma.$transaction(async (tx) => {
      // 条件转移：updateMany 的 where 即消费前置条件，MySQL 行锁保证并发只有一方 count=1。
      const transferred = await tx.refreshToken.updateMany({
        where: {
          tokenHash,
          consumedAt: null,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        data: { consumedAt: now },
      });
      if (transferred.count === 1) {
        return tx.refreshToken.findUnique({ where: { tokenHash } });
      }

      // 转移未命中：查是否是一条已消费过的 token 被再次出示（多 tab 并发 / 泄露重放）。
      const existing = await tx.refreshToken.findUnique({ where: { tokenHash } });
      if (existing !== null && existing.consumedAt !== null) {
        // 区分「多 tab 合法并发」与「真泄露重放」：刚被合法轮换（grace 窗内）的并发再用不吊销
        // （否则误踢正常用户）；超出 grace 才判泄露重放，吊销该 namespace 全部活 refresh（安全兜底）。
        const consumedTooLongAgo =
          now.getTime() - existing.consumedAt.getTime() > REFRESH_REPLAY_GRACE_MS;
        if (consumedTooLongAgo) {
          await tx.refreshToken.updateMany({
            where: { namespace: existing.namespace, revokedAt: null },
            data: { revokedAt: now },
          });
        }
      }
      // 无效/过期/吊销/重放/并发 → 同一个不透明 null（不给探测者 oracle）。
      return null;
    });
  }

  async markReplaced(oldId: string, newId: string): Promise<void> {
    await this.prisma.refreshToken.update({
      where: { id: oldId },
      data: { replacedById: newId },
    });
  }

  async revokeAllForNamespace(namespace: string, now: Date): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { namespace, revokedAt: null },
      data: { revokedAt: now },
    });
  }

  async findByHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
    return this.prisma.refreshToken.findUnique({ where: { tokenHash } });
  }
}
