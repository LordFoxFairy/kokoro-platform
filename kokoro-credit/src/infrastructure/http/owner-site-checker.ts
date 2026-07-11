import { randomUUID } from "node:crypto";
import { AppError, callService, type RequestContext } from "@kokoro/platform-kit";
import { siteActiveResponseSchema } from "@kokoro/site";
import { ownerActiveResponseSchema } from "@kokoro/user";
import type { OwnerSiteActiveChecker, OwnerSiteRef } from "../../application/credit-service.js";

// 跨服务 enforcement：改账前查 site/owner active；非 active 抛 409；不可达由 callService 映射 502（fail-closed，钱安全优先）。
export class HttpOwnerSiteChecker implements OwnerSiteActiveChecker {
  constructor(
    private readonly userBaseUrl: string,
    private readonly siteBaseUrl: string,
    private readonly internalSecret: string,
    private readonly fetchImpl?: typeof fetch,
  ) {}

  async ensureAccountActive(account: OwnerSiteRef): Promise<void> {
    const ctx: RequestContext = {
      requestId: randomUUID(),
      siteId: account.siteId,
      principal: { kind: "system" },
    };
    const fetchOpt = this.fetchImpl ? { fetchImpl: this.fetchImpl } : {};

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
  }
}
