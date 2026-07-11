import { createHash, randomBytes } from "node:crypto";
import {
  MagicLinkInvalidError,
  MagicLinkRateLimitedError,
  type MagicLinkRecord,
  type MagicLinkRepository,
} from "../domain/magic-link.js";

export interface MagicLinkServiceOptions {
  ttlSeconds: number;
  rateLimitMax: number;
  rateLimitWindowSeconds: number;
  // 可注入时钟，便于测试确定 expiresAt/限频窗口；缺省真实时间。
  now?: () => Date;
}

export interface RequestMagicLinkInput {
  siteId: string;
  email: string;
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
  // 同邮箱固定窗口限频，进程内存计数即可（单实例 dev/P2 面）。
  // 生产多副本部署时应换 redis 计数器（INCR+EXPIRE），此 Map 不跨实例。
  private readonly requestWindows = new Map<string, { windowStartMs: number; count: number }>();

  constructor(
    private readonly repository: MagicLinkRepository,
    private readonly options: MagicLinkServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async request(input: RequestMagicLinkInput): Promise<RequestedMagicLink> {
    const now = this.now();
    this.enforceRateLimit(input.email, now);

    // 32 字节 CSPRNG，base64url 无填充；哈希后才落库。
    const linkToken = randomBytes(32).toString("base64url");
    const record = await this.repository.issue({
      siteId: input.siteId,
      email: input.email,
      tokenHash: hashMagicLinkToken(linkToken),
      expiresAt: new Date(now.getTime() + this.options.ttlSeconds * 1000),
      now,
    });
    return { record, linkToken };
  }

  async consume(token: string): Promise<MagicLinkRecord> {
    const record = await this.repository.consume(hashMagicLinkToken(token), this.now());
    if (record === null) {
      throw new MagicLinkInvalidError();
    }
    return record;
  }

  private enforceRateLimit(email: string, now: Date): void {
    const nowMs = now.getTime();
    const windowMs = this.options.rateLimitWindowSeconds * 1000;
    // 顺手清过期窗口，Map 不随邮箱数无界增长。
    for (const [key, window] of this.requestWindows) {
      if (nowMs - window.windowStartMs >= windowMs) {
        this.requestWindows.delete(key);
      }
    }

    const current = this.requestWindows.get(email);
    if (!current || nowMs - current.windowStartMs >= windowMs) {
      this.requestWindows.set(email, { windowStartMs: nowMs, count: 1 });
      return;
    }
    if (current.count >= this.options.rateLimitMax) {
      throw new MagicLinkRateLimitedError(email);
    }
    current.count += 1;
  }
}
