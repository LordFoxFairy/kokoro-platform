import type { DeletionAudit } from "./site-deletion.js";

export type SitePolicyStatus = "active" | "disabled";

export interface SitePolicy extends DeletionAudit {
  id: string;
  siteId: string;
  key: string;
  value: unknown;
  status: SitePolicyStatus;
  createdAt: Date;
  updatedAt: Date;
}
