import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type { PublishedCreditProgramRevision, CreditProgramRevisionTarget } from
  "../../domain/credit-program-catalog.js";

export interface CreditProgramCatalogSnapshot {
  readonly ref: string;
  readonly digest: string;
  readonly epoch: bigint;
}
export interface CreditProgramCatalogPage {
  readonly revisions: readonly PublishedCreditProgramRevision[];
  readonly epochs: readonly bigint[];
  readonly snapshot: CreditProgramCatalogSnapshot;
}
export interface CreditProgramCatalogReadPermit {
  readonly operation: "credit.program.read";
  readonly environment: string;
  readonly region: string;
  readonly authorityBindingDigest: string;
  readonly scope: "global" | "breakglass";
}
export interface CreditProgramCatalogReadTransactionHost {
  read<Result>(permit: CreditProgramCatalogReadPermit,
    work: (transaction: PlatformTransaction) => Promise<Result>): Promise<Result>;
}
export interface CreditProgramCatalogReader {
  get(permit: CreditProgramCatalogReadPermit, target: CreditProgramRevisionTarget): Promise<PublishedCreditProgramRevision | null>;
  list(permit: CreditProgramCatalogReadPermit, input: Readonly<{
    programRef: string | null; publishedAfter: string | null; publishedBefore: string | null;
    afterEpoch: bigint; limit: number; snapshot: CreditProgramCatalogSnapshot | null;
  }>): Promise<CreditProgramCatalogPage>;
  getCommandReceipt(permit: CreditProgramCatalogReadPermit, input: Readonly<{
    commandId: string; idempotencyKey: string; requestDigest: string;
  }>): Promise<Readonly<{
    operation: "credit.program.publish"; recordedAt: string;
    revision: PublishedCreditProgramRevision;
  }> | null>;
}
