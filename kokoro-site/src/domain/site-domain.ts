import type { DeletionAudit } from "./site-deletion.js";

export type SiteDomainStatus = "active" | "disabled" | "pending_verification";

export interface SiteDomain extends DeletionAudit {
  id: string;
  siteId: string;
  host: string;
  status: SiteDomainStatus;
  isPrimary: boolean;
  canonicalHost: string | null;
  createdAt: Date;
  updatedAt: Date;
}
