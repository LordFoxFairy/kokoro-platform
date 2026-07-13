// magic-link 请求限频：email+ip 两维固定窗口。任一维超阈即拒（429）。
// 限频是防滥用不是安全门——后端不可达时 fail-open 放行（登录可用性优先）。

export interface RateLimitDimensions {
  email: string;
  // 调用方来源 IP；缺省=不按 IP 维度限（直连/测试）。
  ip?: string | null;
}

export interface MagicLinkRateLimiter {
  // 消费一次配额：返回 true=放行，false=超限（429）。fail-open 由实现自理，绝不抛。
  consume(dimensions: RateLimitDimensions, now: Date): Promise<boolean>;
}

export interface RateLimitConfig {
  // 单邮箱阈值：防单账号被灌爆。
  max: number;
  // 单 IP 阈值：防单来源枚举多邮箱。通常远大于 max——一个 IP 合法服务多用户（NAT/办公网）。
  ipMax: number;
  windowSeconds: number;
}

// 两维闸：email 恒有（阈值 max）；ip 仅在提供时参与（阈值 ipMax）。返回 [dim, value, limit] 列表。
function dimensionKeys(dimensions: RateLimitDimensions, config: RateLimitConfig): [string, string, number][] {
  const keys: [string, string, number][] = [["email", dimensions.email, config.max]];
  if (dimensions.ip !== undefined && dimensions.ip !== null && dimensions.ip.length > 0) {
    keys.push(["ip", dimensions.ip, config.ipMax]);
  }
  return keys;
}

// 进程内存固定窗口计数（单副本 dev）：Map 不跨实例，多副本部署换 Redis 档。
// 顺手清过期窗口，Map 不随键数无界增长。
export class InMemoryMagicLinkRateLimiter implements MagicLinkRateLimiter {
  private readonly windows = new Map<string, { windowStartMs: number; count: number }>();

  constructor(private readonly config: RateLimitConfig) {}

  async consume(dimensions: RateLimitDimensions, now: Date): Promise<boolean> {
    const nowMs = now.getTime();
    const windowMs = this.config.windowSeconds * 1000;

    for (const [key, window] of this.windows) {
      if (nowMs - window.windowStartMs >= windowMs) {
        this.windows.delete(key);
      }
    }

    // 先判定：任一维已达该维阈值 → 拒，且不递增（拒绝的请求不再撑计数，窗口按首个放行请求起算）。
    for (const [dim, value, limit] of dimensionKeys(dimensions, this.config)) {
      const current = this.windows.get(`${dim}:${value}`);
      if (current && nowMs - current.windowStartMs < windowMs && current.count >= limit) {
        return false;
      }
    }

    for (const [dim, value] of dimensionKeys(dimensions, this.config)) {
      const mapKey = `${dim}:${value}`;
      const current = this.windows.get(mapKey);
      if (!current || nowMs - current.windowStartMs >= windowMs) {
        this.windows.set(mapKey, { windowStartMs: nowMs, count: 1 });
      } else {
        current.count += 1;
      }
    }
    return true;
  }
}

// Redis INCR/EXPIRE 判别口：只用固定窗口两条命令，注入以便测试与 fail-open。
export interface RateLimitRedis {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
}

export interface RateLimiterLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

// Redis 固定窗口计数（多副本一致）：键含 windowId（floor(now/window)），INCR 命中 1 时设 TTL。
// Redis 不可达/报错 → fail-open 放行 + WARN（限频非安全门，登录可用性优先，定案见文件头）。
export class RedisMagicLinkRateLimiter implements MagicLinkRateLimiter {
  constructor(
    private readonly redis: RateLimitRedis,
    private readonly config: RateLimitConfig,
    private readonly logger: RateLimiterLogger = { warn: () => {} },
  ) {}

  async consume(dimensions: RateLimitDimensions, now: Date): Promise<boolean> {
    const windowMs = this.config.windowSeconds * 1000;
    const windowId = Math.floor(now.getTime() / windowMs);
    try {
      let allowed = true;
      for (const [dim, value, limit] of dimensionKeys(dimensions, this.config)) {
        const key = `magiclink:rl:${dim}:${value}:${windowId}`;
        const count = await this.redis.incr(key);
        if (count === 1) {
          await this.redis.expire(key, this.config.windowSeconds);
        }
        if (count > limit) {
          allowed = false;
        }
      }
      return allowed;
    } catch (error) {
      // fail-open：限频后端故障不得阻断登录。只告警，不抛，不拒。
      this.logger.warn("magic-link rate limiter redis unavailable, failing open", {
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  }
}
