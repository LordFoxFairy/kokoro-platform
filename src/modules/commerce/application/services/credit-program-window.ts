import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type { CreditGrantIssuancePort } from "../../../credit/application/contracts/grant-issuance.js";
import type { CreditProgramWindowRepositoryPort } from
  "../contracts/credit-program-window-repository.js";

export class CreditProgramWindowService {
  constructor(private readonly dependencies: Readonly<{
    repository: CreditProgramWindowRepositoryPort;
    creditGrants: CreditGrantIssuancePort;
    reference: () => string;
  }>) {}

  async issueDue(transaction: PlatformTransaction, limit = 25): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("CREDIT_WINDOW_LIMIT_INVALID");
    const due = await this.dependencies.repository.claimDue(transaction, limit);
    let issued = 0;
    for (const enrollment of due) {
      const prepared = await this.dependencies.creditGrants.prepareIssuance(transaction, {
        commandId: null,
        grants: [Object.freeze({
          account: Object.freeze({ siteId: enrollment.siteId, billingAccountId: enrollment.billingAccountId,
            unit: enrollment.unit, liabilityMerchantAccountId: enrollment.liabilityMerchantAccountId }),
          outputLineId: enrollment.outputLineId,
          outputOrdinal: enrollment.outputOrdinal,
          occurrence: enrollment.occurrence,
          creditProgramRevisionRef: enrollment.creditProgramRevisionRef,
          creditProgramRevision: enrollment.creditProgramRevision,
          creditProgramRevisionDigest: enrollment.creditProgramRevisionDigest,
          sourceType: "program_window" as const,
          sourceRef: enrollment.enrollmentRef,
          sourceWindowKey: enrollment.windowKey,
          businessOperationKey: `credit-window:${enrollment.enrollmentRef}:${enrollment.windowKey}`,
          bucketClass: enrollment.bucketClass,
          amount: enrollment.amount,
          burnPriority: enrollment.burnPriority,
          scopePolicy: enrollment.scopePolicy,
          acquiredAt: enrollment.acquiredAt,
          effectiveAt: enrollment.windowStartsAt,
          expiresAt: enrollment.windowEndsAt,
        })],
      });
      if (prepared.kind === "unavailable") continue;
      const receipts = await this.dependencies.creditGrants.issuePrepared(transaction,
        { preparation: prepared.preparation });
      const receipt = receipts[0];
      if (receipts.length !== 1 || receipt === undefined ||
          receipt.creditProgramRevisionRef !== enrollment.creditProgramRevisionRef) {
        throw new Error("CREDIT_WINDOW_GRANT_RECEIPT_INVALID");
      }
      await this.dependencies.repository.recordAcquisition(transaction, {
        acquisitionRef: this.dependencies.reference(), enrollment, receipt,
      });
      issued += 1;
    }
    return issued;
  }
}
