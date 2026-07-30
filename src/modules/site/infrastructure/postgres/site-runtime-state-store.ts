import { createHash } from "node:crypto";
import {
  activateObservedRelease,
  completeActivationDrain,
  deploymentBindingForObservation,
  observePromotion,
  recordActivationEffectFailure,
  requestPromotion,
  type ActivationAttempt,
  type SiteDeploymentObservation,
} from "../../domain/site-lifecycle.js";
import {
  observeSiteTrafficStop,
  recordSiteTrafficStopEffectFailure,
  requestSiteTrafficStopEffect,
  type SiteTrafficStopAttempt,
} from "../../domain/site-traffic-stop.js";
import type {
  SitePromotionCommand,
  SitePromotionObservation,
  SiteTrafficStopCommand,
  SiteTrafficStopProviderObservation,
} from "../../application/contracts/site-deployment-provider.js";
import type {
  SiteRuntimeRepository,
  SiteRuntimeStateStore,
  SiteRuntimeStep,
  SiteRuntimeTransactionRunner,
} from "../../application/contracts/site-runtime-state.js";
import { siteProviderOperationKey } from "../../application/services/site-runtime-dispatcher.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type { PlatformTransactionalDatabaseClient } from "../../../../infrastructure/postgres/client.js";
import { SiteCurrentAuthorizationMutation } from
  "../../application/services/site-current-authorization-mutation.js";

export class PostgresSiteRuntimeStateStore implements SiteRuntimeStateStore {
  constructor(
    private readonly transactions: SiteRuntimeTransactionRunner,
    private readonly repository: SiteRuntimeRepository,
    private readonly authorization: SiteCurrentAuthorizationMutation,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  prepareActivation(attemptRef: string): Promise<SiteRuntimeStep> {
    return this.transactions.execute(async (transaction) => {
      let attempt = await this.activation(transaction, attemptRef);
      if (attempt.state === "succeeded") return complete();
      if (attempt.state === "pointer_committing") return this.commitActivation(transaction, attempt);
      if (attempt.state === "draining") return this.activationDrain(transaction, attempt);
      if (attempt.state === "preparing") {
        attempt = requestPromotion(attempt, siteProviderOperationKey("promote", attempt.attemptRef));
        await this.repository.updateActivation(transaction, attempt);
      }
      return this.promotion(transaction, attempt,
        attempt.state === "promote_requested" ? "promote" : "observe_promotion");
    });
  }

  acceptPromotion(attemptRef: string, observation: SitePromotionObservation): Promise<SiteRuntimeStep> {
    return this.transactions.execute(async (transaction) => {
      const attempt = await this.activation(transaction, attemptRef);
      if (attempt.state === "succeeded") return complete();
      if (observation.status === "unknown" || observation.status === "rejected") {
        const next = recordActivationEffectFailure(
          attempt,
          observation.status === "rejected" ? "failed" : "unknown",
          observation.status === "rejected" ? "PROVIDER_REJECTED" : "PROVIDER_OBSERVATION_UNKNOWN",
        );
        await this.repository.updateActivation(transaction, next);
        return this.promotion(transaction, next, "observe_promotion");
      }
      if (observation.deploymentRef === null) throw new Error("SITE_PROVIDER_DEPLOYMENT_REQUIRED");
      const evidence = promotionEvidence(attempt, observation);
      const next = observePromotion(attempt, evidence);
      await this.repository.recordObservationAndCandidateDeployment(
        transaction,
        evidence,
        deploymentBindingForObservation(attempt, evidence),
      );
      await this.repository.updateActivation(transaction, next);
      return next.state === "pointer_committing"
        ? this.commitActivation(transaction, next)
        : this.promotion(transaction, next, "observe_promotion");
    });
  }

  acceptActivationDrain(
    attemptRef: string,
    observation: SiteTrafficStopProviderObservation,
  ): Promise<SiteRuntimeStep> {
    return this.transactions.execute(async (transaction) => {
      const attempt = await this.activation(transaction, attemptRef);
      if (attempt.state === "succeeded") return complete();
      const drain = await this.activationDrain(transaction, attempt);
      if (drain.kind !== "stop_activation_drain") throw new Error("SITE_DRAIN_STATE_INVALID");
      if (observation.status !== "stopped") return drain;
      const evidence = drainEvidence(attempt, drain.command, drain.webArtifactDigest, observation);
      const next = completeActivationDrain(attempt, evidence);
      await this.repository.recordDrainObservationAndComplete(transaction, evidence, next);
      return complete();
    });
  }

  prepareTrafficStop(attemptRef: string): Promise<SiteRuntimeStep> {
    return this.transactions.execute(async (transaction) => {
      let attempt = await this.trafficStop(transaction, attemptRef);
      if (attempt.state === "succeeded") return complete();
      if (attempt.state === "requested") {
        attempt = requestSiteTrafficStopEffect(
          attempt,
          siteProviderOperationKey("traffic-stop", attempt.attemptRef),
        );
        await this.repository.updateTrafficStop(transaction, attempt);
      }
      return this.trafficStep(transaction, attempt,
        attempt.state === "stop_requested" ? "stop_site_traffic" : "observe_site_traffic");
    });
  }

  acceptTrafficStop(
    attemptRef: string,
    observation: SiteTrafficStopProviderObservation,
  ): Promise<SiteRuntimeStep> {
    return this.transactions.execute(async (transaction) => {
      const attempt = await this.trafficStop(transaction, attemptRef);
      if (attempt.state === "succeeded") return complete();
      if (observation.status === "rejected") {
        const next = recordSiteTrafficStopEffectFailure(attempt, "failed", "PROVIDER_REJECTED");
        await this.repository.updateTrafficStop(transaction, next);
        return this.trafficStep(transaction, next, "observe_site_traffic");
      }
      const evidence = {
        observationRef: observationRef("traffic-stop", attemptRef, observation.payloadDigest),
        providerOperationKey: requiredOperationKey(attempt.providerOperationKey),
        deploymentRef: attempt.deploymentRef,
        status: observation.status,
        observedAt: observation.observedAt,
        payloadDigest: observation.payloadDigest,
      } as const;
      const result = observeSiteTrafficStop(attempt, evidence);
      if (result.attempt.state === "succeeded") {
        await this.authorization.execute(transaction, {
          siteRef: attempt.siteRef,
          correlationId: `site-runtime:${attempt.attemptRef}`,
        }, () => this.repository.recordTrafficStopObservation(
          transaction,
          { ...evidence, attemptRef },
          result.attempt,
          result.site,
        ));
      } else {
        await this.repository.recordTrafficStopObservation(
          transaction,
          { ...evidence, attemptRef },
          result.attempt,
          result.site,
        );
      }
      return result.attempt.state === "succeeded"
        ? complete()
        : this.trafficStep(transaction, result.attempt, "observe_site_traffic");
    });
  }

  recordActivationFailure(
    attemptRef: string,
    outcome: "failed" | "unknown",
    code: string,
  ): Promise<SiteRuntimeStep> {
    return this.transactions.execute(async (transaction) => {
      const attempt = await this.activation(transaction, attemptRef);
      const next = recordActivationEffectFailure(attempt, outcome, code);
      await this.repository.updateActivation(transaction, next);
      if (next.state === "draining") return this.activationDrain(transaction, next);
      return this.promotion(transaction, next, "observe_promotion");
    });
  }

  recordTrafficStopFailure(
    attemptRef: string,
    outcome: "failed" | "unknown",
    code: string,
  ): Promise<SiteRuntimeStep> {
    return this.transactions.execute(async (transaction) => {
      const attempt = await this.trafficStop(transaction, attemptRef);
      const next = recordSiteTrafficStopEffectFailure(attempt, outcome, code);
      await this.repository.updateTrafficStop(transaction, next);
      return this.trafficStep(transaction, next, "observe_site_traffic");
    });
  }

  private async commitActivation(
    transaction: PlatformTransaction,
    attempt: ActivationAttempt,
  ): Promise<SiteRuntimeStep> {
    let result: ReturnType<typeof activateObservedRelease> | undefined;
    await this.authorization.execute(transaction, {
      siteRef: attempt.siteRef,
      correlationId: `site-runtime:${attempt.attemptRef}`,
    }, async () => {
      const [site, candidate] = await Promise.all([
        this.repository.loadSiteForUpdate(transaction, attempt.siteRef),
        this.repository.loadReleaseForUpdate(transaction, attempt.siteRef, attempt.candidateReleaseRef),
      ]);
      if (site === null || candidate === null) throw new Error("SITE_ACTIVATION_TARGET_NOT_FOUND");
      result = activateObservedRelease({
        site,
        candidate,
        attempt,
        currentActiveReleaseRef: site.activeReleaseRef,
        committedAt: this.now(),
      });
      await this.repository.commitActivation(transaction, {
        ...result,
        expectedActiveReleaseRef: attempt.expectedActiveReleaseRef,
      });
    });
    if (result === undefined) throw new Error("SITE_ACTIVATION_MUTATION_INCOMPLETE");
    return result.attempt.state === "succeeded"
      ? complete()
      : this.activationDrain(transaction, result.attempt);
  }

  private async activationDrain(
    transaction: PlatformTransaction,
    attempt: ActivationAttempt,
  ): Promise<SiteRuntimeStep> {
    if (attempt.state !== "draining" || attempt.expectedActiveReleaseRef === null) {
      throw new Error("SITE_DRAIN_STATE_INVALID");
    }
    const deployment = await this.repository.loadDrainingRuntimeDeploymentForUpdate(
      transaction,
      attempt.siteRef,
      attempt.environment,
      attempt.region,
      attempt.expectedActiveReleaseRef,
    );
    if (deployment === null) throw new Error("SITE_DRAIN_DEPLOYMENT_NOT_FOUND");
    return { kind: "stop_activation_drain", providerNamespace: deployment.providerNamespace,
      webArtifactDigest: deployment.webArtifactDigest,
      command: { operationKey: siteProviderOperationKey("activation-drain", attempt.attemptRef),
        siteRef: attempt.siteRef, providerProjectRef: deployment.providerProjectRef,
        deploymentRef: deployment.deploymentRef, environment: deployment.environment,
        region: deployment.region } };
  }

  private async promotion(
    transaction: PlatformTransaction,
    attempt: ActivationAttempt,
    kind: "promote" | "observe_promotion",
  ): Promise<SiteRuntimeStep> {
    const binding = await this.repository.loadRuntimeProjectBindingForUpdate(transaction, {
      bindingRef: attempt.siteProjectBindingRef,
      siteRef: attempt.siteRef,
      bindingEpoch: attempt.siteProjectBindingEpoch,
      environment: attempt.environment,
      region: attempt.region,
    });
    if (binding === null) throw new Error("SITE_RUNTIME_PROJECT_BINDING_NOT_FOUND");
    const command: SitePromotionCommand = {
      operationKey: requiredOperationKey(attempt.providerOperationKey),
      siteRef: attempt.siteRef,
      providerProjectRef: binding.providerProjectRef,
      releaseRef: attempt.candidateReleaseRef,
      webArtifactDigest: attempt.candidateWebArtifactDigest,
      releaseManifestDigest: attempt.candidateManifestDigest,
      certificationDigest: attempt.candidateCertificationDigest,
      environment: attempt.environment,
      region: attempt.region,
    };
    return { kind, providerNamespace: binding.providerNamespace, command };
  }

  private async trafficStep(
    transaction: PlatformTransaction,
    attempt: SiteTrafficStopAttempt,
    kind: "stop_site_traffic" | "observe_site_traffic",
  ): Promise<SiteRuntimeStep> {
    const binding = await this.repository.loadRuntimeProjectBindingForUpdate(transaction, {
      bindingRef: attempt.bindingRef,
      siteRef: attempt.siteRef,
      environment: attempt.environment,
      region: attempt.region,
    });
    if (binding === null || binding.providerNamespace !== attempt.providerNamespace) {
      throw new Error("SITE_RUNTIME_PROJECT_BINDING_NOT_FOUND");
    }
    const command: SiteTrafficStopCommand = {
      operationKey: requiredOperationKey(attempt.providerOperationKey),
      siteRef: attempt.siteRef,
      providerProjectRef: binding.providerProjectRef,
      deploymentRef: attempt.deploymentRef,
      environment: attempt.environment,
      region: attempt.region,
    };
    return { kind, providerNamespace: binding.providerNamespace, command };
  }

  private async activation(transaction: PlatformTransaction, attemptRef: string): Promise<ActivationAttempt> {
    const attempt = await this.repository.loadActivationForUpdate(transaction, attemptRef);
    if (attempt === null) throw new Error("SITE_ACTIVATION_NOT_FOUND");
    return attempt;
  }

  private async trafficStop(transaction: PlatformTransaction, attemptRef: string): Promise<SiteTrafficStopAttempt> {
    const attempt = await this.repository.loadTrafficStopForUpdate(transaction, attemptRef);
    if (attempt === null) throw new Error("SITE_TRAFFIC_STOP_NOT_FOUND");
    return attempt;
  }
}

export function createPostgresSiteRuntimeTransactionRunner(
  database: PlatformTransactionalDatabaseClient,
): SiteRuntimeTransactionRunner {
  return Object.freeze({
    execute: <Result>(work: (transaction: PlatformTransaction) => Promise<Result>) =>
      database.internalTransaction("site.runtime.consume", work),
  });
}

function promotionEvidence(
  attempt: ActivationAttempt,
  observation: SitePromotionObservation,
): SiteDeploymentObservation {
  return {
    observationRef: observationRef("promotion", attempt.attemptRef, observation.payloadDigest),
    attemptRef: attempt.attemptRef,
    providerOperationKey: requiredOperationKey(attempt.providerOperationKey),
    deploymentRef: requiredDeployment(observation.deploymentRef),
    releaseRef: attempt.candidateReleaseRef,
    webArtifactDigest: attempt.candidateWebArtifactDigest,
    healthy: observation.status === "ready",
    trafficReady: observation.status === "ready",
    observedAt: observation.observedAt,
    payloadDigest: observation.payloadDigest,
  };
}

function drainEvidence(
  attempt: ActivationAttempt,
  command: SiteTrafficStopCommand,
  webArtifactDigest: string,
  observation: SiteTrafficStopProviderObservation,
): SiteDeploymentObservation {
  if (attempt.expectedActiveReleaseRef === null) throw new Error("SITE_DRAIN_STATE_INVALID");
  return {
    observationRef: observationRef("activation-drain", attempt.attemptRef, observation.payloadDigest),
    attemptRef: attempt.attemptRef,
    providerOperationKey: command.operationKey,
    deploymentRef: command.deploymentRef,
    releaseRef: attempt.expectedActiveReleaseRef,
    webArtifactDigest,
    healthy: false,
    trafficReady: false,
    observedAt: observation.observedAt,
    payloadDigest: observation.payloadDigest,
  };
}

function complete(): SiteRuntimeStep { return Object.freeze({ kind: "complete" }); }
function requiredOperationKey(value: string | null): string {
  if (value === null) throw new Error("SITE_PROVIDER_OPERATION_KEY_REQUIRED");
  return value;
}
function requiredDeployment(value: string | null): string {
  if (value === null) throw new Error("SITE_PROVIDER_DEPLOYMENT_REQUIRED");
  return value;
}
function observationRef(kind: string, attemptRef: string, payloadDigest: string): string {
  const hex = createHash("sha256").update("kokoro-site-observation-v1\0").update(kind)
    .update("\0").update(attemptRef).update("\0").update(payloadDigest).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
