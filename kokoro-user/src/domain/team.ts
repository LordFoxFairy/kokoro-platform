export type TeamType = "personal" | "team";
export type TeamStatus = "active" | "disabled";

export interface Team {
  id: string;
  name: string;
  slug?: string | null;
  type: TeamType;
  ownerUserId: string;
  status: TeamStatus;
  createdAt: Date;
  updatedAt: Date;
}
