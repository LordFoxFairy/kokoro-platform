import type { DomainVerifier } from "../domain/domain-verifier.js";
import type {
  ResolveSiteContextInput,
  SiteRepository,
  UpsertSiteAppInput,
  UpsertSiteDomainInput,
  UpsertSiteFeatureFlagInput,
  UpsertSiteInput,
  UpsertSitePolicyInput,
} from "../domain/repository.js";
import { SiteLifecycleError } from "../domain/site-deletion.js";
import type { DeleteInput, RestoreInput } from "../domain/site-deletion.js";
import type { SiteDomain } from "../domain/site-domain.js";

// 域名验证结果：verified=是否通过；未通过时 reason 说明原因（留 pending）。
export type VerifySiteDomainResult =
  | { verified: true; domain: SiteDomain }
  | { verified: false; reason: string; domain: SiteDomain };

export class SiteService {
  constructor(
    private readonly repository: SiteRepository,
    private readonly verifier: DomainVerifier,
  ) {}

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

  // 运营触发 DNS 验证：查域名 TXT 记录，命中 verification_token → 标记 verified；否则留 pending + 原因。
  async verifySiteDomain(id: string): Promise<VerifySiteDomainResult> {
    const domain = await this.repository.getSiteDomainById(id);
    if (!domain) {
      throw new SiteLifecycleError("site_domain.not_found", "站点域名不存在", 404);
    }
    if (!domain.verificationToken) {
      return { verified: false, reason: "no_verification_token", domain };
    }

    const records = await this.verifier.lookupTxt(domain.host);
    if (!records.includes(domain.verificationToken)) {
      return { verified: false, reason: "txt_record_not_found", domain };
    }

    const verified = await this.repository.markSiteDomainVerified(id);
    return { verified: true, domain: verified };
  }

  // 本地/开发域直标 verified（显式动作，不自动）：仅 localhost/127.0.0.1 等本地 host 放行。
  async markSiteDomainVerified(id: string): Promise<SiteDomain> {
    const domain = await this.repository.getSiteDomainById(id);
    if (!domain) {
      throw new SiteLifecycleError("site_domain.not_found", "站点域名不存在", 404);
    }
    if (!isLocalHost(domain.host)) {
      throw new SiteLifecycleError(
        "site_domain.not_local",
        "仅本地/开发域名可直标验证，公网域名须走 DNS 验证",
        400,
      );
    }
    return this.repository.markSiteDomainVerified(id);
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

// 本地/开发 host：允许 admin 直标 verified（DNS 无从查询）。host 已由仓库归一为小写。
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

function isLocalHost(host: string): boolean {
  const bare = host.split(":")[0] ?? host;
  return LOCAL_HOSTS.has(host) || LOCAL_HOSTS.has(bare) || bare.endsWith(".localhost");
}
