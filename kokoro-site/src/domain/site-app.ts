export type SiteSurface = "general" | "studio" | "api" | "admin" | "public_seo";
export type SiteAppStatus = "active" | "disabled";

export interface SiteApp {
  id: string;
  siteId: string;
  appKey: string;
  surface: SiteSurface;
  status: SiteAppStatus;
  defaultRoute: string | null;
  createdAt: Date;
  updatedAt: Date;
}
