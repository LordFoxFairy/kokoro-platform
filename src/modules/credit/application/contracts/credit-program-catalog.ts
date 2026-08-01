import type { CommandIdentity } from "../../../../shared/outbox-inbox/receipt.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type { PublishedCreditProgramRevision } from "../../domain/credit-program-catalog.js";

export interface CreditProgramPublicationCommand extends CommandIdentity {
  readonly expectedVersion: bigint;
  readonly reason: string;
  readonly actorSubjectId: string;
}

export type CreditProgramPublicationOutcome =
  | Readonly<{ kind: "published"; revision: PublishedCreditProgramRevision; recordedAt: string }>
  | Readonly<{ kind: "replayed"; revision: PublishedCreditProgramRevision; recordedAt: string }>;

export interface CreditProgramCatalogRepository {
  publishRevision(
    transaction: PlatformTransaction,
    command: CreditProgramPublicationCommand,
    candidate: PublishedCreditProgramRevision,
  ): Promise<CreditProgramPublicationOutcome>;
}
