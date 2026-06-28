import type { Site } from "./site.js";
import type { SiteApp, SiteSurface } from "./site-app.js";

export interface SiteContext {
  siteId: string;
  siteKey: string;
  host: string;
  appKey?: string | undefined;
  surface?: SiteSurface | undefined;
  defaultLocale: string;
  timezone: string;
}

export interface ResolvedSiteContext {
  context: SiteContext;
  site: Site;
  app?: SiteApp | undefined;
}
