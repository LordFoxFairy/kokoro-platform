import type { MembershipRole } from "./membership.js";

export type InviteStatus = "pending" | "accepted" | "revoked" | "expired";

// 邀请实体对外投影：不含 tokenHash（服务端秘密），只露成员流转所需字段。
export interface Invite {
  id: string;
  teamId: string;
  email: string;
  role: MembershipRole;
  status: InviteStatus;
  expiresAt: Date;
  acceptedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
