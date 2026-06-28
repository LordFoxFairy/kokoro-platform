export type SiteDomainStatus = "active" | "disabled" | "pending_verification";

export interface SiteDomain {
  id: string;
  siteId: string;
  host: string;
  status: SiteDomainStatus;
  isPrimary: boolean;
  canonicalHost: string | null;
  createdAt: Date;
  updatedAt: Date;
}
