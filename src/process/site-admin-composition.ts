import type { PlatformTransactionalDatabaseClient } from "../infrastructure/postgres/client.js";
import { SiteDangerousAdminHandler } from "../modules/site/application/site-dangerous-admin-handler.js";
import { SiteEffectApprovalService } from "../modules/site/application/services/site-effect-approval-service.js";
import { SiteLifecycleService } from "../modules/site/application/services/site-lifecycle-service.js";
import { SiteTrafficStopService } from "../modules/site/application/services/site-traffic-stop-service.js";
import { PostgresSiteAuthorityJournal } from "../modules/site/infrastructure/postgres/site-authority-journal.js";
import { PostgresSiteAuthorityRepository } from "../modules/site/infrastructure/postgres/site-authority-repository.js";
import { PostgresSiteEffectApprovalAuthority } from "../modules/site/infrastructure/postgres/site-effect-approval-authority.js";
import { PlatformUnitOfWork } from "../shared/unit-of-work/index.js";
import type { SessionAuthorizationEventSigner } from
  "../modules/authorization/application/contracts/session-authorization-ports.js";
import { PostgresScopedAuthorizationFeedRepository } from
  "../modules/authorization/infrastructure/postgres/scoped-authorization-feed-repository.js";
import { SignedScopedSessionAuthorizationPublisher } from
  "../modules/authorization/infrastructure/postgres/signed-scoped-session-authorization-publisher.js";
import { SiteCurrentAuthorizationMutation } from
  "../modules/site/application/services/site-current-authorization-mutation.js";
import { PostgresSiteCurrentAuthorizationReader } from
  "../modules/site/infrastructure/postgres/site-current-authorization-reader.js";

export interface PlatformSiteAdminComposition {
  readonly site: SiteDangerousAdminHandler;
}

/** Production control-plane composition. Site owner calls remain in-process and transactional. */
export function createPlatformSiteAdminComposition(
  database: PlatformTransactionalDatabaseClient,
  eventSigner: SessionAuthorizationEventSigner,
): PlatformSiteAdminComposition {
  const unitOfWork = new PlatformUnitOfWork(database);
  const repository = new PostgresSiteAuthorityRepository();
  const journal = new PostgresSiteAuthorityJournal();
  const approvalAuthority = new PostgresSiteEffectApprovalAuthority();
  const authorization = createSiteAuthorizationMutation(eventSigner);
  const approvals = new SiteEffectApprovalService(unitOfWork, approvalAuthority);
  const lifecycle = new SiteLifecycleService(unitOfWork, repository, journal, {
    approvalAuthority,
    preconditions: repository,
  });
  const trafficStop = new SiteTrafficStopService(unitOfWork, repository, journal, {
    approvalAuthority,
    authorization,
  });
  return Object.freeze({
    site: new SiteDangerousAdminHandler(approvals, lifecycle, trafficStop),
  });
}

export function createSiteAuthorizationMutation(
  eventSigner: SessionAuthorizationEventSigner,
): SiteCurrentAuthorizationMutation {
  const publisher = new SignedScopedSessionAuthorizationPublisher(
    new PostgresScopedAuthorizationFeedRepository(),
    eventSigner,
  );
  return new SiteCurrentAuthorizationMutation(
    publisher,
    new PostgresSiteCurrentAuthorizationReader(),
  );
}
