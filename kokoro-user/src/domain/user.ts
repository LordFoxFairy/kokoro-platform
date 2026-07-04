import type { DeletionAudit } from "./user-deletion.js";

export type UserStatus = "active" | "disabled";

export interface User extends DeletionAudit {
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
