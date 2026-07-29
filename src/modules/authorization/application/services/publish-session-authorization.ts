import type { SessionAuthorizationPublisher } from "../contracts/session-authorization-ports.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";

/**
 * Site-wide security/policy/lifecycle workflows call this first in their existing transaction,
 * before acquiring the Site authorization lock. Identity, credential, subject, and membership
 * workflows must never use this Site-wide fence; they require scoped v2 facts. Feed publication
 * always locks global stream then Site and deliberately opens no nested transaction.
 */
export class PublishSessionAuthorizationService {
  constructor(private readonly publisher: SessionAuthorizationPublisher) {}

  async bumpSiteRevocationInOwnerTransaction(transaction: PlatformTransaction, input: Readonly<{
    siteRef: string;
    expectedRevocationEpoch: string;
    reason: string;
    changedAt: string;
    correlationId: string;
  }>): Promise<string> {
    return this.publisher.bumpAndPublishRevocationEpochChanged(transaction, {
      siteRef: input.siteRef,
      expectedRevocationEpoch: input.expectedRevocationEpoch,
      reason: input.reason,
      changedAt: input.changedAt,
      correlationId: input.correlationId,
    });
  }
}
