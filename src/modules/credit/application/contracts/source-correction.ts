import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";

/** Credit-owned query for immutable correction evidence attached to an exact source namespace. */
export interface CreditSourceCorrectionPort {
  listCorrectionRefs(transaction: PlatformTransaction, input: Readonly<{
    siteId: string;
    sourceType: "redemption" | "admin_grant" | "program_window";
    sourceRefPrefix: string;
  }>): Promise<readonly string[]>;
}
