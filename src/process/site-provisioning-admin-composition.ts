import type { PlatformTransactionalDatabaseClient } from
  "../infrastructure/postgres/client.js";
import type { SiteReleaseCertificationAuthority } from
  "../modules/site/application/contracts/site-publication-ports.js";
import { SitePublicationService } from
  "../modules/site/application/services/site-publication-service.js";
import { PostgresSiteAuthorityJournal } from
  "../modules/site/infrastructure/postgres/site-authority-journal.js";
import { PostgresSiteAuthorityRepository } from
  "../modules/site/infrastructure/postgres/site-authority-repository.js";
import { PlatformUnitOfWork } from "../shared/unit-of-work/index.js";

export interface PlatformSiteProvisioningComposition {
  readonly publication: SitePublicationService;
}

/** Production Site provisioning composition; no self-RPC and no sibling database access. */
export function createPlatformSiteProvisioningComposition(
  database: PlatformTransactionalDatabaseClient,
  certification: SiteReleaseCertificationAuthority,
  options: Readonly<{ now?: () => string }> = {},
): PlatformSiteProvisioningComposition {
  const unitOfWork = new PlatformUnitOfWork(database);
  return Object.freeze({
    publication: new SitePublicationService(
      unitOfWork,
      new PostgresSiteAuthorityRepository(),
      new PostgresSiteAuthorityJournal(),
      certification,
      options,
    ),
  });
}
