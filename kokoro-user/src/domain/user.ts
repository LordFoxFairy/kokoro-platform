export type UserStatus = "active" | "disabled";

export interface User {
  id: string;
  externalUserId: string;
  email?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  status: UserStatus;
  createdAt: Date;
  updatedAt: Date;
}
