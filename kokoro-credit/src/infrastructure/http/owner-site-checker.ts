import { randomUUID } from "node:crypto";
import { AppError, callService, type RequestContext } from "@kokoro/platform-kit";
import { siteActiveResponseSchema } from "@kokoro/site";
import { ownerActiveResponseSchema } from "@kokoro/user";
import type { OwnerSiteActiveChecker, OwnerSiteRef } from "../../application/credit-service.js";

export interface ActiveCacheOptions {
  ttlMs: number;
  maxEntries: number;
}

// 短 TTL 进程内正向缓存：只缓存 active=true。负向结果（inactive/不可达）永不缓存，
// fail-closed 语义不被缓存放松——封禁/挂起最迟一个 TTL 后全量生效，恢复 active 立即生效。
class PositiveTtlCache {
  private readonly entries = new Map<string, number>();

  constructor(private readonly options: ActiveCacheOptions) {}

  has(key: string): boolean {
    if (this.options.ttlMs <= 0) return false;
    const expiresAt = this.entries.get(key);
    if (expiresAt === undefined) return false;
    if (Date.now() >= expiresAt) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  set(key: string): void {
    if (this.options.ttlMs <= 0) return;
    // Map 按插入序迭代：先删再插保持近似 LRU，超上限逐最旧，防无界膨胀。
    this.entries.delete(key);
    if (this.entries.size >= this.options.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, Date.now() + this.options.ttlMs);
  }
}

// 跨服务 enforcement：改账前查 site/owner active；非 active 抛 409；不可达由 callService 映射 502（fail-closed，钱安全优先）。
export class HttpOwnerSiteChecker implements OwnerSiteActiveChecker {
  private readonly siteCache: PositiveTtlCache;
  private readonly ownerCache: PositiveTtlCache;

  constructor(
    private readonly userBaseUrl: string,
    private readonly siteBaseUrl: string,
    private readonly internalSecret: string,
    private readonly fetchImpl?: typeof fetch,
    cacheOptions: ActiveCacheOptions = { ttlMs: 30_000, maxEntries: 10_000 },
  ) {
    this.siteCache = new PositiveTtlCache(cacheOptions);
    this.ownerCache = new PositiveTtlCache(cacheOptions);
  }

  async ensureAccountActive(account: OwnerSiteRef): Promise<void> {
    const ctx: RequestContext = {
      requestId: randomUUID(),
      siteId: account.siteId,
      principal: { kind: "system" },
    };
    const fetchOpt = this.fetchImpl ? { fetchImpl: this.fetchImpl } : {};

    const siteKey = account.siteId;
    if (!this.siteCache.has(siteKey)) {
      const site = await callService(ctx, {
        baseUrl: this.siteBaseUrl,
        method: "GET",
        path: `/sites/${account.siteId}/active`,
        schema: siteActiveResponseSchema,
        internalSecret: this.internalSecret,
        ...fetchOpt,
      });
      if (!site.active) {
        throw new AppError("site.suspended", 409, `site suspended: ${account.siteId}`);
      }
      this.siteCache.set(siteKey);
    }

    // owner 缓存键含 siteId：ownerId 只在 site 内唯一，跨 site 复用同一 (ownerKind,ownerId)
    // 缓存会串站——site A 暖缓存后 site B 同 owner 必须重新校验（纲领 §8.2-4）。
    const ownerKey = `${account.siteId}:${account.ownerKind}:${account.ownerId}`;
    if (!this.ownerCache.has(ownerKey)) {
      const owner = await callService(ctx, {
        baseUrl: this.userBaseUrl,
        method: "GET",
        path: `/owners/${account.ownerKind}/${account.ownerId}/active`,
        schema: ownerActiveResponseSchema,
        internalSecret: this.internalSecret,
        ...fetchOpt,
      });
      if (!owner.active) {
        throw new AppError("owner.inactive", 409, `owner inactive: ${account.ownerKind}/${account.ownerId}`);
      }
      this.ownerCache.set(ownerKey);
    }
  }
}
