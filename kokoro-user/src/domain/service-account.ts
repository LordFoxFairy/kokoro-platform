export type ServiceAccountStatus = "active" | "disabled";

export interface ServiceAccount {
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
