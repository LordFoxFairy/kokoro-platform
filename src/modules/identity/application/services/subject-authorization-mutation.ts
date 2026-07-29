import type {
  ScopedSubjectAuthorizationMutationPort,
  SubjectCurrentFact,
} from "../../../authorization/application/contracts/scoped-session-authorization-port.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";

export class SubjectAuthorizationMutation {
  constructor(private readonly authorization: ScopedSubjectAuthorizationMutationPort) {}

  async execute(
    transaction: PlatformTransaction,
    input: Readonly<{ siteRef: string; correlationId: string }>,
    mutateExactOwner: () => Promise<SubjectCurrentFact>,
  ): Promise<SubjectCurrentFact> {
    const reservation = await this.authorization.reserveSubjectMutation(transaction, { siteRef: input.siteRef });
    const current = await mutateExactOwner();
    if (reservation.siteRef !== input.siteRef || current.siteRef !== reservation.siteRef) {
      throw new Error("SCOPED_AUTHORIZATION_OWNER_MISMATCH");
    }
    await this.authorization.publishSubjectCurrent(transaction, {
      reservation, current, correlationId: input.correlationId,
    });
    return current;
  }
}
