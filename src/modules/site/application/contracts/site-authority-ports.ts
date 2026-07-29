import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
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
    environment: "development" | "preview" | "production",
  ): Promise<Readonly<{ bindingRef: string; bindingEpoch: bigint }> | null>;
  loadSiteForUpdate(transaction: PlatformTransaction, siteRef: string): Promise<SiteAggregate | null>;
  loadReleaseForUpdate(
    transaction: PlatformTransaction,
    siteRef: string,
    releaseRef: string,
  ): Promise<SiteRelease | null>;
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
