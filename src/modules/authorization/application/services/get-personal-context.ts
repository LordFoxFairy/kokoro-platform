import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import { PlatformUnitOfWork } from "../../../../shared/unit-of-work/unit-of-work.js";
import type { SessionAuthorizationRepository } from "../contracts/session-authorization-ports.js";
import type {
  AuthenticatedUserSession,
  PersonalContextSnapshot,
  ProductWorkloadIdentity,
} from "../../domain/session-access-grant.js";

export class GetPersonalContextService {
  constructor(
    private readonly unitOfWork: PlatformUnitOfWork,
    private readonly repository: SessionAuthorizationRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  execute(input: Readonly<{
    workload: ProductWorkloadIdentity;
    session: AuthenticatedUserSession;
    context: VerifiedRequestSecurityContext;
  }>): Promise<PersonalContextSnapshot> {
    const nowDate = this.clock();
    const now = instant(nowDate);
    const expiresAt = instant(new Date(Math.min(
      nowDate.getTime() + 300_000,
      Date.parse(input.session.expiresAt),
    )));
    return this.unitOfWork.execute(
      { context: input.context, operation: "getPersonalContext" },
      (transaction) => this.repository.loadPersonalContext(transaction, {
        workload: input.workload,
        session: input.session,
        now,
        expiresAt,
      }),
    );
  }
}

function instant(value: Date): string {
  return new Date(Math.floor(value.getTime() / 1_000) * 1_000).toISOString();
}
