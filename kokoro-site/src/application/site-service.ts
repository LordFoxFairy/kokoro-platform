import type {
  ResolveSiteContextInput,
  SiteRepository,
  UpsertSiteAppInput,
  UpsertSiteDomainInput,
  UpsertSiteFeatureFlagInput,
  UpsertSiteInput,
  UpsertSitePolicyInput,
} from "../domain/repository.js";
import type { DeleteInput, RestoreInput } from "../domain/site-deletion.js";

export class SiteService {
  constructor(private readonly repository: SiteRepository) {}

  async upsertSite(input: UpsertSiteInput) {
    return this.repository.upsertSite(input);
  }

  async deleteSite(input: DeleteInput) {
    return this.repository.deleteSite(input);
  }

  async restoreSite(input: RestoreInput) {
    return this.repository.restoreSite(input);
  }

  async upsertSiteDomain(input: UpsertSiteDomainInput) {
    return this.repository.upsertSiteDomain(input);
  }

  async deleteSiteDomain(input: DeleteInput) {
    return this.repository.deleteSiteDomain(input);
  }

  async restoreSiteDomain(input: RestoreInput) {
    return this.repository.restoreSiteDomain(input);
  }

  async upsertSiteApp(input: UpsertSiteAppInput) {
    return this.repository.upsertSiteApp(input);
  }

  async upsertSitePolicy(input: UpsertSitePolicyInput) {
    return this.repository.upsertSitePolicy(input);
  }

  async upsertSiteFeatureFlag(input: UpsertSiteFeatureFlagInput) {
    return this.repository.upsertSiteFeatureFlag(input);
  }

  async listSiteFeatureFlags(siteId: string) {
    return this.repository.listSiteFeatureFlags(siteId);
  }

  // 把站点的开关行投影成消费侧友好的 key→enabled 字典。
  async resolveFlags(siteId: string): Promise<Record<string, boolean>> {
    const flags = await this.repository.listSiteFeatureFlags(siteId);
    const resolved: Record<string, boolean> = {};
    for (const flag of flags) {
      resolved[flag.key] = flag.enabled;
    }
    return resolved;
  }

  async resolveSiteContext(input: ResolveSiteContextInput) {
    return this.repository.resolveSiteContext(input);
  }

  // 下游记账前校验站点是否 active（停站即时生效）。
  async resolveSiteActive(siteId: string): Promise<boolean> {
    return this.repository.resolveSiteActive(siteId);
  }

  async listSites() {
    return this.repository.listSites();
  }
}
