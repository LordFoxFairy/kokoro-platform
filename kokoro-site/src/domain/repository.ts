import type { ResolvedSiteContext } from "./site-context.js";
import type { Site } from "./site.js";
import type { SiteApp, SiteSurface } from "./site-app.js";
import type { SiteDomain } from "./site-domain.js";
import type { SitePolicy } from "./site-policy.js";

export interface UpsertSiteInput {
  key: string;
  name: string;
  status?: Site["status"] | undefined;
  defaultLocale?: string | undefined;
  timezone?: string | undefined;
  metadata?: unknown;
}

export interface UpsertSiteDomainInput {
  siteId: string;
  host: string;
  status?: SiteDomain["status"] | undefined;
  isPrimary?: boolean | undefined;
  canonicalHost?: string | undefined;
  metadata?: unknown;
}

export interface UpsertSiteAppInput {
  siteId: string;
  appKey: string;
  surface: SiteSurface;
  status?: SiteApp["status"] | undefined;
  defaultRoute?: string | undefined;
  metadata?: unknown;
}

export interface UpsertSitePolicyInput {
  siteId: string;
  key: string;
  value: Record<string, unknown>;
  status?: SitePolicy["status"] | undefined;
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
  resolveSiteContext(input: ResolveSiteContextInput): Promise<ResolvedSiteContext | null>;
  listSites(): Promise<Site[]>;
}
