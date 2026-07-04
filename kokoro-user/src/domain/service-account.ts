import type { DeletionAudit } from "./user-deletion.js";

export type ServiceAccountStatus = "active" | "disabled";

export interface ServiceAccount extends DeletionAudit {
  id: string;
  teamId?: string | null;
  ownerUserId?: string | null;
  name: string;
  tokenPrefix: string;
  status: ServiceAccountStatus;
  lastUsedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
