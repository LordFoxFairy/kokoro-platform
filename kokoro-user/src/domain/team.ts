import type { DeletionAudit } from "./user-deletion.js";

export type TeamType = "personal" | "team";
export type TeamStatus = "active" | "disabled";

export interface Team extends DeletionAudit {
  id: string;
  siteId: string;
  name: string;
  slug?: string | null;
  type: TeamType;
  ownerUserId: string;
  status: TeamStatus;
  createdAt: Date;
  updatedAt: Date;
}
