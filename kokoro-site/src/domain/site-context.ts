import type { Site } from "./site.js";
import type { SiteApp, SiteSurface } from "./site-app.js";

// host resolve 投影给消费侧（web）的最小品牌面：name 必有，logo/主题色可空。
export interface SiteBrand {
  name: string;
  logoUrl: string | null;
  themeColor: string | null;
}

export interface SiteContext {
  siteId: string;
  siteKey: string;
  host: string;
  appKey?: string | undefined;
  surface?: SiteSurface | undefined;
  defaultLocale: string;
  timezone: string;
  brand: SiteBrand;
}

export interface ResolvedSiteContext {
  context: SiteContext;
  site: Site;
  app?: SiteApp | undefined;
}
