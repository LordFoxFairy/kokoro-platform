import type { AdminQueryPermit } from "../../../admin/interfaces/connect/admin-query-service.js";

export type CreditGrantProgramAdministrationRecord = Readonly<{
  siteId: string; creditProgramRevisionRef: string; programRef: string; revision: bigint;
  uxBucketClass: "daily" | "period" | "permanent"; unit: string; amount: string;
  burnPriority: number; scopePolicy: Readonly<{ version: 1; surfaceRefs: readonly string[];
    capabilityKeys: readonly string[]; agentRefs: readonly string[]; allowUnattributedAgent: boolean }>;
  liabilityMerchantAccountRef: string; windowKind: "none" | "daily" | "period"; rolloverPolicy: "none";
  calendarZone: string | null; windowAnchor: string | null; expiresAfterSeconds: bigint | null;
  revisionDigest: string; publishedAt: string;
}>;

export type CreditGrantProgramAdministrationPage = Readonly<{
  siteId: string; afterRef: string | null; watermark: string; limit: number;
}>;

export interface CreditGrantProgramAdministrationReader {
  getCreditProgramRevision(permit: AdminQueryPermit, siteId: string,
    revisionRef: string): Promise<CreditGrantProgramAdministrationRecord | null>;
  listCreditProgramRevisions(permit: AdminQueryPermit,
    input: CreditGrantProgramAdministrationPage): Promise<readonly CreditGrantProgramAdministrationRecord[]>;
}
