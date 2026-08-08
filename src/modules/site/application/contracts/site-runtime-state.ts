import type {
  SitePromotionCommand,
  SitePromotionObservation,
  SiteTrafficStopCommand,
  SiteTrafficStopProviderObservation,
} from "./site-deployment-provider.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type { DeploymentEnvironment } from "../../../../shared/deployment-environment.js";
import type {
  ActivationAttempt,
  SiteAggregate,
  SiteDeploymentBinding,
  SiteDeploymentObservation,
  SiteRelease,
} from "../../domain/site-lifecycle.js";
import type {
  SiteTrafficStopAttempt,
  SiteTrafficStopObservation,
} from "../../domain/site-traffic-stop.js";

export type SiteRuntimeStep =
  | Readonly<{ kind: "complete" }>
  | Readonly<{ kind: "promote" | "observe_promotion"; providerNamespace: string; command: SitePromotionCommand }>
  | Readonly<{ kind: "stop_activation_drain"; providerNamespace: string;
    webArtifactDigest: string; command: SiteTrafficStopCommand }>
  | Readonly<{ kind: "stop_site_traffic" | "observe_site_traffic"; providerNamespace: string;
    command: SiteTrafficStopCommand }>;

export interface SiteRuntimeStateStore {
  prepareActivation(attemptRef: string): Promise<SiteRuntimeStep>;
  acceptPromotion(attemptRef: string, observation: SitePromotionObservation): Promise<SiteRuntimeStep>;
  acceptActivationDrain(
    attemptRef: string,
    observation: SiteTrafficStopProviderObservation,
  ): Promise<SiteRuntimeStep>;
  prepareTrafficStop(attemptRef: string): Promise<SiteRuntimeStep>;
  acceptTrafficStop(
    attemptRef: string,
    observation: SiteTrafficStopProviderObservation,
  ): Promise<SiteRuntimeStep>;
  recordActivationFailure(
    attemptRef: string,
    outcome: "failed" | "unknown",
    code: string,
  ): Promise<SiteRuntimeStep>;
  recordTrafficStopFailure(
    attemptRef: string,
    outcome: "failed" | "unknown",
    code: string,
  ): Promise<SiteRuntimeStep>;
}

export interface SiteRuntimeTransactionRunner {
  execute<Result>(work: (transaction: PlatformTransaction) => Promise<Result>): Promise<Result>;
}

export interface SiteRuntimeRepository {
  loadActivationForUpdate(transaction: PlatformTransaction, attemptRef: string): Promise<ActivationAttempt | null>;
  updateActivation(transaction: PlatformTransaction, attempt: ActivationAttempt): Promise<void>;
  loadRuntimeProjectBindingForUpdate(
    transaction: PlatformTransaction,
    input: Readonly<{ bindingRef: string; siteRef: string; bindingEpoch?: bigint;
      environment: DeploymentEnvironment; region: string }>,
  ): Promise<Readonly<{ providerNamespace: string; providerProjectRef: string }> | null>;
  recordObservationAndCandidateDeployment(
    transaction: PlatformTransaction,
    observation: SiteDeploymentObservation,
    deployment: SiteDeploymentBinding,
  ): Promise<void>;
  loadSiteForUpdate(transaction: PlatformTransaction, siteRef: string): Promise<SiteAggregate | null>;
  loadReleaseForUpdate(transaction: PlatformTransaction, siteRef: string, releaseRef: string): Promise<SiteRelease | null>;
  commitActivation(transaction: PlatformTransaction, input: Readonly<{
    site: SiteAggregate; candidate: SiteRelease; attempt: ActivationAttempt;
    expectedActiveReleaseRef: string | null; drainingReleaseRef: string | null;
  }>): Promise<void>;
  loadDrainingRuntimeDeploymentForUpdate(
    transaction: PlatformTransaction,
    siteRef: string,
    environment: DeploymentEnvironment,
    region: string,
    releaseRef: string,
  ): Promise<Readonly<{ deploymentRef: string; webArtifactDigest: string;
    providerNamespace: string; providerProjectRef: string;
    environment: DeploymentEnvironment; region: string }> | null>;
  recordDrainObservationAndComplete(
    transaction: PlatformTransaction,
    observation: SiteDeploymentObservation,
    attempt: ActivationAttempt,
  ): Promise<void>;
  loadTrafficStopForUpdate(transaction: PlatformTransaction, attemptRef: string): Promise<SiteTrafficStopAttempt | null>;
  updateTrafficStop(transaction: PlatformTransaction, attempt: SiteTrafficStopAttempt): Promise<void>;
  recordTrafficStopObservation(
    transaction: PlatformTransaction,
    observation: SiteTrafficStopObservation,
    attempt: SiteTrafficStopAttempt,
    site: Pick<SiteAggregate, "state" | "activeReleaseRef">,
  ): Promise<void>;
}
