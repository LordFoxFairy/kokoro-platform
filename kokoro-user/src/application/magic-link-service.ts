import { createHash, randomBytes } from "node:crypto";
import {
  MagicLinkInvalidError,
  MagicLinkRateLimitedError,
  type MagicLinkRecord,
  type MagicLinkRepository,
} from "../domain/magic-link.js";
import {
  InMemoryMagicLinkRateLimiter,
  type MagicLinkRateLimiter,
} from "./magic-link-rate-limiter.js";

export interface MagicLinkServiceOptions {
  ttlSeconds: number;
  rateLimitMax: number;
  // 单 IP 阈值：缺省 = rateLimitMax * 10（IP 合法服务多用户，阈值须远宽于单邮箱）。
  rateLimitIpMax?: number;
  rateLimitWindowSeconds: number;
  // 限频后端注入：缺省=进程内存固定窗口（单副本 dev）；生产注入 Redis 档。
  rateLimiter?: MagicLinkRateLimiter;
  // 可注入时钟，便于测试确定 expiresAt/限频窗口；缺省真实时间。
  now?: () => Date;
}

export interface RequestMagicLinkInput {
  siteId: string;
  email: string;
  // 签发方（web BFF）给的一次性 nonce 哈希；省略/null = 不绑定设备（直连调用）。
  nonceHash?: string | null;
  // 调用方来源 IP：参与 email+ip 两维限频；省略/null = 仅按 email 维度限（直连/测试）。
  ip?: string | null;
}

export interface RequestedMagicLink {
  record: MagicLinkRecord;
  // 一次性原文 token：只在签发瞬间存在于内存/投递通道，持久层只有 SHA-256 哈希。
  linkToken: string;
}

export function hashMagicLinkToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// magic-link 编排：签发（限频+旧链作废+哈希落库）与消费（条件转移，失败统一 invalid）。
export class MagicLinkService {
  private readonly now: () => Date;
  // 限频后端：缺省进程内存固定窗口（单副本 dev）；生产注入 Redis 档（多副本一致）。
  private readonly rateLimiter: MagicLinkRateLimiter;

  constructor(
    private readonly repository: MagicLinkRepository,
    private readonly options: MagicLinkServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.rateLimiter =
      options.rateLimiter ??
      new InMemoryMagicLinkRateLimiter({
        max: options.rateLimitMax,
        ipMax: options.rateLimitIpMax ?? options.rateLimitMax * 10,
        windowSeconds: options.rateLimitWindowSeconds,
      });
  }

  async request(input: RequestMagicLinkInput): Promise<RequestedMagicLink> {
    const now = this.now();
    const allowed = await this.rateLimiter.consume({ email: input.email, ip: input.ip ?? null }, now);
    if (!allowed) {
      throw new MagicLinkRateLimitedError(input.email);
    }

    // 32 字节 CSPRNG，base64url 无填充；哈希后才落库。
    const linkToken = randomBytes(32).toString("base64url");
    const record = await this.repository.issue({
      siteId: input.siteId,
      email: input.email,
      tokenHash: hashMagicLinkToken(linkToken),
      nonceHash: input.nonceHash ?? null,
      expiresAt: new Date(now.getTime() + this.options.ttlSeconds * 1000),
      now,
    });
    return { record, linkToken };
  }

  // nonceHash 缺省 null：与未绑定链匹配；绑定链要求消费方带回同一 nonce 哈希，否则统一 invalid。
  async consume(token: string, nonceHash: string | null = null): Promise<MagicLinkRecord> {
    const record = await this.repository.consume(hashMagicLinkToken(token), nonceHash, this.now());
    if (record === null) {
      throw new MagicLinkInvalidError();
    }
    return record;
  }
}
