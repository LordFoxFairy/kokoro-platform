import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type { CreditGrantScopePolicy } from "../../../credit/application/contracts/grant-issuance.js";

export type CreditGrantProgramRevision = Readonly<{
  revisionRef: string;
  revision: bigint;
  revisionDigest: string;
  bucketClass: "daily" | "period" | "permanent";
  unit: string;
  amount: string;
  expiresAfterSeconds: bigint | null;
  windowKind: "none" | "daily" | "period";
  calendarZone: string | null;
  windowAnchor: string | null;
  liabilityMerchantAccountId: string;
  burnPriority: number;
  scopePolicy: CreditGrantScopePolicy;
}>;

export type CreditGrantProgramTarget = Readonly<{
  revisionRef: string;
  revision: bigint;
  revisionDigest: string;
}>;

/** Commerce-owned immutable Program catalog; consumers receive only exact revision snapshots. */
export interface CreditGrantProgramPort {
  resolveTargets(transaction: PlatformTransaction, input: Readonly<{
    siteId: string;
    targets: readonly CreditGrantProgramTarget[];
  }>): Promise<readonly CreditGrantProgramRevision[]>;
  resolveRefs(transaction: PlatformTransaction, input: Readonly<{
    siteId: string;
    revisionRefs: readonly string[];
  }>): Promise<readonly CreditGrantProgramRevision[]>;
  publishRevision(transaction: PlatformTransaction, input: Readonly<{
    siteId: string;
    revisionRef: string;
    programRef: string;
    revision: bigint;
    bucketClass: "daily" | "period" | "permanent";
    unit: string;
    amount: string;
    burnPriority: number;
    scopePolicy: CreditGrantScopePolicy;
    liabilityMerchantAccountId: string;
    windowKind: "none" | "daily" | "period";
    rolloverPolicy: "none";
    calendarZone: string | null;
    windowAnchor: string | null;
    expiresAfterSeconds: bigint | null;
    revisionDigest: string;
    catalogEpoch: bigint;
    publishedAt: string;
  }>): Promise<void>;
}
