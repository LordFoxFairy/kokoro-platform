export type SitePolicyStatus = "active" | "disabled";

export interface SitePolicy {
  id: string;
  siteId: string;
  key: string;
  value: unknown;
  status: SitePolicyStatus;
  createdAt: Date;
  updatedAt: Date;
}
