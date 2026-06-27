export type MembershipRole = "owner" | "admin" | "member";
export type MembershipStatus = "active" | "disabled";

export interface Membership {
  id: string;
  teamId: string;
  userId: string;
  role: MembershipRole;
  status: MembershipStatus;
  createdAt: Date;
  updatedAt: Date;
}
