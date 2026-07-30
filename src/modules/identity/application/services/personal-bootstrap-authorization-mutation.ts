import type {
  ScopedAuthorizationBatchReservationPort,
  ScopedProjectMembershipAuthorizationMutationPort,
  ScopedSubjectAuthorizationMutationPort,
} from "../../../authorization/application/contracts/scoped-session-authorization-port.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type { PersonalBootstrapAuthorizationFacts } from "../contracts/identity-repository.js";

type PersonalBootstrapPublisher = ScopedAuthorizationBatchReservationPort &
  Pick<ScopedSubjectAuthorizationMutationPort, "publishSubjectCurrent"> &
  Pick<ScopedProjectMembershipAuthorizationMutationPort, "publishProjectMembershipCurrent">;

export class PersonalBootstrapAuthorizationMutation {
  constructor(private readonly authorization: PersonalBootstrapPublisher) {}

  async execute(
    transaction: PlatformTransaction,
    input: Readonly<{ siteRef: string; correlationId: string }>,
    mutateExactOwners: () => Promise<PersonalBootstrapAuthorizationFacts>,
  ): Promise<PersonalBootstrapAuthorizationFacts> {
    const reservations = await this.authorization.reserveOwnerMutations(transaction, {
      siteRef: input.siteRef,
      count: 2,
    });
    const subjectReservation = reservations[0];
    const membershipReservation = reservations[1];
    if (reservations.length !== 2 || subjectReservation === undefined || membershipReservation === undefined) {
      throw new Error("SCOPED_AUTHORIZATION_RESERVATION_FAILED");
    }
    const current = await mutateExactOwners();
    if (current.subject.siteRef !== input.siteRef || current.membership.siteRef !== input.siteRef ||
        current.membership.subjectRef !== current.subject.subjectRef) {
      throw new Error("SCOPED_AUTHORIZATION_OWNER_MISMATCH");
    }
    await this.authorization.publishSubjectCurrent(transaction, {
      reservation: subjectReservation,
      current: current.subject,
      correlationId: input.correlationId,
    });
    await this.authorization.publishProjectMembershipCurrent(transaction, {
      reservation: membershipReservation,
      current: current.membership,
      correlationId: input.correlationId,
    });
    return current;
  }
}
