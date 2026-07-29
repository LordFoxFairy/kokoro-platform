import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type { SiteAggregate, SiteDeploymentBinding } from "../../domain/site-lifecycle.js";
import type {
  SiteTrafficStopAttempt,
  SiteTrafficStopObservation,
} from "../../domain/site-traffic-stop.js";

export type ProviderBoundDeployment = SiteDeploymentBinding & Readonly<{ providerNamespace: string }>;

export interface SiteTrafficStopRepository {
  loadSiteForUpdate(transaction: PlatformTransaction, siteRef: string): Promise<SiteAggregate | null>;
  loadActiveDeploymentForUpdate(
    transaction: PlatformTransaction,
    siteRef: string,
    environment: "development" | "preview" | "production",
    region: string,
  ): Promise<ProviderBoundDeployment | null>;
  loadTrafficStopForUpdate(
    transaction: PlatformTransaction,
    attemptRef: string,
  ): Promise<SiteTrafficStopAttempt | null>;
  beginTrafficStop(
    transaction: PlatformTransaction,
    site: SiteAggregate,
    attempt: SiteTrafficStopAttempt,
  ): Promise<void>;
  updateTrafficStop(transaction: PlatformTransaction, attempt: SiteTrafficStopAttempt): Promise<void>;
  recordTrafficStopObservation(
    transaction: PlatformTransaction,
    observation: SiteTrafficStopObservation,
    attempt: SiteTrafficStopAttempt,
    site: Pick<SiteAggregate, "state" | "activeReleaseRef">,
  ): Promise<void>;
}
