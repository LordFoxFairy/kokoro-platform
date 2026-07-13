import type { DeletionAudit } from "./site-deletion.js";

export type SiteDomainStatus = "active" | "disabled" | "pending_verification";

export interface SiteDomain extends DeletionAudit {
  id: string;
  siteId: string;
  host: string;
  status: SiteDomainStatus;
  isPrimary: boolean;
  canonicalHost: string | null;
  // TXT 记录值（展示给运营），create 时生成；status=active 即已验证。
  verificationToken: string | null;
  verifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
