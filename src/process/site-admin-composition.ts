import type { PlatformTransactionalDatabaseClient } from "../infrastructure/postgres/client.js";
import { SiteDangerousAdminHandler } from "../modules/site/application/site-dangerous-admin-handler.js";
import { SiteEffectApprovalService } from "../modules/site/application/services/site-effect-approval-service.js";
import { SiteLifecycleService } from "../modules/site/application/services/site-lifecycle-service.js";
import { SiteTrafficStopService } from "../modules/site/application/services/site-traffic-stop-service.js";
import { PostgresSiteAuthorityJournal } from "../modules/site/infrastructure/postgres/site-authority-journal.js";
import { PostgresSiteAuthorityRepository } from "../modules/site/infrastructure/postgres/site-authority-repository.js";
import { PostgresSiteEffectApprovalAuthority } from "../modules/site/infrastructure/postgres/site-effect-approval-authority.js";
import { PlatformUnitOfWork } from "../shared/unit-of-work/index.js";

export interface PlatformSiteAdminComposition {
  readonly site: SiteDangerousAdminHandler;
}

/** Production control-plane composition. Site owner calls remain in-process and transactional. */
export function createPlatformSiteAdminComposition(
  database: PlatformTransactionalDatabaseClient,
): PlatformSiteAdminComposition {
  const unitOfWork = new PlatformUnitOfWork(database);
  const repository = new PostgresSiteAuthorityRepository();
  const journal = new PostgresSiteAuthorityJournal();
  const approvalAuthority = new PostgresSiteEffectApprovalAuthority();
  const approvals = new SiteEffectApprovalService(unitOfWork, approvalAuthority);
  const lifecycle = new SiteLifecycleService(unitOfWork, repository, journal, {
    approvalAuthority,
    preconditions: repository,
  });
  const trafficStop = new SiteTrafficStopService(unitOfWork, repository, journal, {
    approvalAuthority,
  });
  return Object.freeze({
    site: new SiteDangerousAdminHandler(approvals, lifecycle, trafficStop),
  });
}
