export type UserStatus = "active" | "disabled";

export interface User {
  id: string;
  siteId: string;
  externalUserId: string;
  email?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  status: UserStatus;
  disabledAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
