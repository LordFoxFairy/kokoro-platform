import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type { CommandIdentity } from "../../../../shared/outbox-inbox/receipt.js";

export type CommerceAdminActor = Readonly<{
  siteId: string;
  subjectId: string;
  subjectGeneration: string;
  command: CommandIdentity;
}>;

export interface CommerceAdministrationRepository {
  publishProgram(transaction: PlatformTransaction, input: CommerceAdminActor & Readonly<{
    redemptionProgramRevisionRef: string; programRef: string; revision: string; productVersionRef: string;
    fulfillmentProgramRevisionRef: string; programDigest: string; maxRedemptionsPerAccount: number;
  }>): Promise<"committed" | "replayed">;
  issueBatch(transaction: PlatformTransaction, input: CommerceAdminActor & Readonly<{
    batchRef: string; batchSelector: string; redemptionProgramRevisionRef: string; keyRevision: string;
    startsAt: string | null; endsAt: string | null; exportDigest: string;
    codes: readonly Readonly<{ codeRef: string; lookupDigest: string; safeFingerprint: string }>[];
  }>): Promise<Readonly<{ kind: "committed" | "replayed"; occurredAt: string }>>;
  approveBatch(transaction: PlatformTransaction, input: CommerceAdminActor & Readonly<{
    batchRef: string; approvalDigest: string;
  }>): Promise<"committed" | "replayed">;
  activateBatch(transaction: PlatformTransaction, input: CommerceAdminActor & Readonly<{
    batchRef: string;
  }>): Promise<"committed" | "replayed">;
}
