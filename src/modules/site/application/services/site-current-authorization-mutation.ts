import type {
  ScopedSiteAuthorizationMutationPort,
  SiteCurrentFact,
} from "../../../authorization/application/contracts/scoped-session-authorization-port.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";

export interface SiteCurrentAuthorizationReader {
  loadSiteCurrent(transaction: PlatformTransaction, siteRef: string): Promise<SiteCurrentFact | null>;
}

/**
 * Atomic SiteCurrent coordinator.
 *
 * Reservation is deliberately first: the feed global lock and Site cursor lock
 * are held before the owner mutation, and the signed replacement fact is
 * appended before the surrounding transaction can commit.
 */
export class SiteCurrentAuthorizationMutation {
  constructor(
    private readonly publisher: ScopedSiteAuthorizationMutationPort,
    private readonly reader: SiteCurrentAuthorizationReader,
  ) {}

  async execute(
    transaction: PlatformTransaction,
    input: Readonly<{ siteRef: string; correlationId: string }>,
    mutateOwner: () => Promise<void>,
  ): Promise<SiteCurrentFact> {
    const reservation = await this.publisher.reserveSiteMutation(transaction, {
      siteRef: input.siteRef,
    });
    await mutateOwner();
    const current = await this.reader.loadSiteCurrent(transaction, input.siteRef);
    if (current === null || current.siteRef !== input.siteRef) {
      throw new Error("SITE_AUTHORIZATION_CURRENT_NOT_FOUND");
    }
    await this.publisher.publishSiteCurrent(transaction, {
      reservation,
      current,
      correlationId: input.correlationId,
    });
    return current;
  }
}
