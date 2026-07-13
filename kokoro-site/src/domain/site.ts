import type { DeletionAudit } from "./site-deletion.js";

export type SiteStatus = "draft" | "sandbox" | "beta" | "active" | "suspended" | "archived";

export interface Site extends DeletionAudit {
  id: string;
  key: string;
  name: string;
  status: SiteStatus;
  defaultLocale: string;
  timezone: string;
  brandLogoUrl: string | null;
  brandThemeColor: string | null;
  createdAt: Date;
  updatedAt: Date;
}
