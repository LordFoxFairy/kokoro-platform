import type { SiteActivationAuthorityReaderPort } from
  "../modules/site/application/contracts/site-activation-authority.js";
import { SiteActiveReleaseAuthority } from
  "../modules/site/application/services/site-active-release-authority.js";
import { PostgresSiteActivationPointerRepository } from
  "../modules/site/infrastructure/postgres/site-activation-pointer-repository.js";
import { PostgresSitePublicationAuthorityRepository } from
  "../modules/site/infrastructure/postgres/site-publication-authority-repository.js";

/** Transaction-local policy composition injected into the lifecycle owner. */
export function createSiteActiveReleaseAuthorityProductionComposition(
  authority: SiteActivationAuthorityReaderPort,
  options: Readonly<{ now?: () => string }> = {},
): Readonly<{ activeRelease: SiteActiveReleaseAuthority }> {
  return Object.freeze({
    activeRelease: new SiteActiveReleaseAuthority(
      new PostgresSitePublicationAuthorityRepository(),
      new PostgresSiteActivationPointerRepository(),
      authority,
      options.now,
    ),
  });
}
