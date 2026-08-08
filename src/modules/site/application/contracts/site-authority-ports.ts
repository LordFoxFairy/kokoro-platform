import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import type { OutboxEvent } from "../../../../shared/outbox-inbox/outbox.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type { DeploymentEnvironment } from "../../../../shared/deployment-environment.js";
import type {
  ActivationAttempt,
  SiteDeploymentBinding,
  SiteDeploymentObservation,
  SiteAggregate,
  SiteRelease,
} from "../../domain/site-lifecycle.js";

export interface SiteAuthorityRepository {
  loadActiveProjectBindingForUpdate(
    transaction: PlatformTransaction,
    siteRef: string,
    environment: DeploymentEnvironment,
    region: string,
  ): Promise<Readonly<{ bindingRef: string; bindingEpoch: bigint }> | null>;
  reserveRuntimeBindingEpoch(
    transaction: PlatformTransaction,
    siteRef: string,
    expectedEpoch: bigint,
  ): Promise<bigint>;
  loadSiteForUpdate(transaction: PlatformTransaction, siteRef: string): Promise<SiteAggregate | null>;
  loadReleaseForUpdate(
    transaction: PlatformTransaction,
    siteRef: string,
    releaseRef: string,
  ): Promise<SiteRelease | null>;
  loadActivationForBegin(
    transaction: PlatformTransaction,
    attemptRef: string,
  ): Promise<ActivationAttempt | null>;
  loadActivationForUpdate(
    transaction: PlatformTransaction,
    attemptRef: string,
  ): Promise<ActivationAttempt | null>;
  insertActivation(transaction: PlatformTransaction, attempt: ActivationAttempt): Promise<void>;
  updateActivation(transaction: PlatformTransaction, attempt: ActivationAttempt): Promise<void>;
  recordObservationAndCandidateDeployment(
    transaction: PlatformTransaction,
    observation: SiteDeploymentObservation,
    deployment: SiteDeploymentBinding,
  ): Promise<void>;
  loadDrainingDeploymentForUpdate(
    transaction: PlatformTransaction,
    siteRef: string,
    environment: DeploymentEnvironment,
    releaseRef: string,
  ): Promise<Readonly<{ deploymentRef: string; webArtifactDigest: string }> | null>;
  recordDrainObservationAndComplete(
    transaction: PlatformTransaction,
    observation: SiteDeploymentObservation,
    attempt: ActivationAttempt,
  ): Promise<void>;
  commitActivation(
    transaction: PlatformTransaction,
    input: Readonly<{
      site: SiteAggregate;
      candidate: SiteRelease;
      attempt: ActivationAttempt;
      expectedActiveReleaseRef: string | null;
      drainingReleaseRef: string | null;
    }>,
  ): Promise<void>;
  updateSite(transaction: PlatformTransaction, site: SiteAggregate): Promise<void>;
}

export interface SiteAuthorityCommand {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly operation: string;
  readonly siteRef: string;
  readonly callerIdentity: string;
  readonly environment: string;
  readonly region: string;
  readonly requestDigest: string;
}

export interface SiteAuthorityReceipt {
  readonly attemptRef?: string;
  readonly siteRef?: string;
  readonly state: string;
  readonly replayed: boolean;
  readonly recordedAt?: string;
}

export interface SiteAuthorityJournal {
  begin(
    transaction: PlatformTransaction,
    command: SiteAuthorityCommand,
  ): Promise<"fresh" | "replay">;
  succeed(
    transaction: PlatformTransaction,
    command: SiteAuthorityCommand,
    receipt: SiteAuthorityReceipt,
    context: VerifiedRequestSecurityContext,
  ): Promise<void>;
}

export const SITE_EFFECT_EVENT_TYPES = Object.freeze([
  "site.activation.begin.v1",
  "site.traffic-stop.request.v1",
] as const);

export type SiteEffectEventType = (typeof SITE_EFFECT_EVENT_TYPES)[number];

export type SiteEffectQueueEntry = OutboxEvent & Readonly<{
  owner: "site";
  eventType: SiteEffectEventType;
}>;

export interface SiteEffectQueuePort {
  enqueue(transaction: PlatformTransaction, event: SiteEffectQueueEntry): Promise<void>;
}
