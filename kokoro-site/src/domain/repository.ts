import type { JsonObject } from "./json.js";
import type { ResolvedSiteContext } from "./site-context.js";
import type { DeleteInput, ListOptions, RestoreInput } from "./site-deletion.js";
import type { Site } from "./site.js";
import type { SiteApp, SiteSurface } from "./site-app.js";
import type { SiteDomain } from "./site-domain.js";
import type { SiteFeatureFlag } from "./site-feature-flag.js";
import type { SitePolicy } from "./site-policy.js";

export interface UpsertSiteInput {
  key: string;
  name: string;
  status?: Site["status"] | undefined;
  defaultLocale?: string | undefined;
  timezone?: string | undefined;
  metadata?: JsonObject | undefined;
}

export interface UpsertSiteDomainInput {
  siteId: string;
  host: string;
  status?: SiteDomain["status"] | undefined;
  isPrimary?: boolean | undefined;
  canonicalHost?: string | undefined;
  metadata?: JsonObject | undefined;
}

export interface UpsertSiteAppInput {
  siteId: string;
  appKey: string;
  surface: SiteSurface;
  status?: SiteApp["status"] | undefined;
  defaultRoute?: string | undefined;
  metadata?: JsonObject | undefined;
}

export interface UpsertSitePolicyInput {
  siteId: string;
  key: string;
  value: JsonObject;
  status?: SitePolicy["status"] | undefined;
}

export interface UpsertSiteFeatureFlagInput {
  siteId: string;
  key: string;
  enabled: boolean;
  metadata?: JsonObject | undefined;
}

export interface ResolveSiteContextInput {
  host: string;
  appKey?: string | undefined;
  surface?: SiteSurface | undefined;
}

export interface SiteRepository {
  upsertSite(input: UpsertSiteInput): Promise<Site>;
  upsertSiteDomain(input: UpsertSiteDomainInput): Promise<SiteDomain>;
  upsertSiteApp(input: UpsertSiteAppInput): Promise<SiteApp>;
  upsertSitePolicy(input: UpsertSitePolicyInput): Promise<SitePolicy>;
  upsertSiteFeatureFlag(input: UpsertSiteFeatureFlagInput): Promise<SiteFeatureFlag>;
  listSiteFeatureFlags(siteId: string): Promise<SiteFeatureFlag[]>;
  deleteSite(input: DeleteInput): Promise<Site>;
  restoreSite(input: RestoreInput): Promise<Site>;
  deleteSiteDomain(input: DeleteInput): Promise<SiteDomain>;
  restoreSiteDomain(input: RestoreInput): Promise<SiteDomain>;
  resolveSiteContext(input: ResolveSiteContextInput): Promise<ResolvedSiteContext | null>;
  // 下游记账前校验：siteId 对应站点是否 active；不存在/非 active 返回 false。
  resolveSiteActive(siteId: string): Promise<boolean>;
  listSites(options?: ListOptions): Promise<Site[]>;
  listAdminSites(options?: ListOptions): Promise<Site[]>;
  listAdminSiteDomains(options?: ListOptions): Promise<SiteDomain[]>;
  listAdminSiteApps(options?: ListOptions): Promise<SiteApp[]>;
  listAdminSitePolicies(options?: ListOptions): Promise<SitePolicy[]>;
  listAdminSiteFeatureFlags(options?: ListOptions): Promise<SiteFeatureFlag[]>;
}
