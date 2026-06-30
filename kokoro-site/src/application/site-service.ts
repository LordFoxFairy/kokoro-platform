import type {
  ResolveSiteContextInput,
  SiteRepository,
  UpsertSiteAppInput,
  UpsertSiteDomainInput,
  UpsertSiteFeatureFlagInput,
  UpsertSiteInput,
  UpsertSitePolicyInput,
} from "../domain/repository.js";

export class SiteService {
  constructor(private readonly repository: SiteRepository) {}

  async upsertSite(input: UpsertSiteInput) {
    return this.repository.upsertSite(input);
  }

  async upsertSiteDomain(input: UpsertSiteDomainInput) {
    return this.repository.upsertSiteDomain(input);
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

  async listSites() {
    return this.repository.listSites();
  }
}
