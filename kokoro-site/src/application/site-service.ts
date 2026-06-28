import type {
  ResolveSiteContextInput,
  SiteRepository,
  UpsertSiteAppInput,
  UpsertSiteDomainInput,
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

  async resolveSiteContext(input: ResolveSiteContextInput) {
    return this.repository.resolveSiteContext(input);
  }

  async listSites() {
    return this.repository.listSites();
  }
}
