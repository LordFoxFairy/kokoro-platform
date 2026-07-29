import type {
  IdentitySessionCurrentFact,
  ScopedSessionAuthorizationMutationPort,
} from "../../../authorization/application/contracts/scoped-session-authorization-port.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";

export class IdentitySessionAuthorizationMutation {
  constructor(private readonly authorization: ScopedSessionAuthorizationMutationPort) {}

  async execute(
    transaction: PlatformTransaction,
    input: Readonly<{ siteRef: string; correlationId: string }>,
    mutateExactOwner: () => Promise<IdentitySessionCurrentFact>,
  ): Promise<IdentitySessionCurrentFact> {
    const reservation = await this.authorization.reserveIdentitySessionMutation(transaction, {
      siteRef: input.siteRef,
    });
    const current = await mutateExactOwner();
    if (reservation.siteRef !== input.siteRef || current.siteRef !== reservation.siteRef) {
      throw new Error("SCOPED_AUTHORIZATION_OWNER_MISMATCH");
    }
    await this.authorization.publishIdentitySessionCurrent(transaction, {
      reservation,
      current,
      correlationId: input.correlationId,
    });
    return current;
  }
}
