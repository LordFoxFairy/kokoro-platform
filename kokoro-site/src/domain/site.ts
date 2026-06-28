export type SiteStatus = "draft" | "sandbox" | "beta" | "active" | "suspended" | "archived";

export interface Site {
  id: string;
  key: string;
  name: string;
  status: SiteStatus;
  defaultLocale: string;
  timezone: string;
  createdAt: Date;
  updatedAt: Date;
}
