import type { DeletionAudit } from "./user-deletion.js";

export type MembershipRole = "owner" | "admin" | "member";
export type MembershipStatus = "active" | "disabled";

export interface Membership extends DeletionAudit {
  id: string;
  teamId: string;
  userId: string;
  role: MembershipRole;
  status: MembershipStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdminMembership extends Membership {
  siteId: string;
}
